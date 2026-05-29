// ══════════════════════════════════════════════════════
//  Grad-Deploy v2  ·  환경변수 관리 모듈 (8번 작업)
//  - ConfigMap / Secret 자동 분류
//  - 컴포넌트 간 값 전파
//  - 일관성 검증
//  - .gitignore 자동 생성
//
//  ⚠️  Sealed Secrets는 MVP 범위 외 (PDF ADR-003 §12)
//      Phase 2 확장 항목 — Controller 설치·키 백업 운영 책임이
//      'Phase 1은 기존 클러스터 + Minikube' 원칙과 상충
//      MVP 보안: .gitignore + secrets.example.yaml (NF-13) 로 충족
// ══════════════════════════════════════════════════════

// ── 공통 경로 헬퍼 ─────────────────────────────────────
export function getServicePath(proj, svcName) {
  return ['k8s', 'projects', proj, 'services', svcName].join('/')
}

export function getOverlayPath(proj) {
  return ['k8s', 'projects', proj, 'overlays', 'production'].join('/')
}

// ── 민감 키워드 패턴 (Secret 분류 기준) ───────────────
// PDF §9.1 명세:
//   1순위: 변수 카탈로그의 sensitive 플래그 (현재 ENV_SPEC의 category 필드)
//   2순위: 아래 키워드 매칭 (fallback)
//
// ⚠️ 'key' 단독 제외 이유 (PDF §9.1 명시):
//   PUBLIC_KEY, CACHE_KEY, ENCRYPTION_KEY_ID 등이 Secret으로 오분류됨
//   민감 키는 반드시 password/secret/token/api_key/private_key 등 구체 패턴만 허용
const SECRET_KEYWORDS = [
  'password', 'secret', 'token',
  'api_key',                   // ANTHROPIC_API_KEY, OPENAI_API_KEY
  'private_key',               // RSA_PRIVATE_KEY 등
  'auth',                      // AUTH_TOKEN, OAUTH_SECRET
  'credential',                // DB_CREDENTIAL
  'jwt',                       // JWT_SECRET, JWT_TOKEN
]

// 단어 경계 기반 매칭: 키를 '_'로 분리하여 각 토큰과 정확히 대조
// 예: "MYSQL_PUBLIC_KEY" → tokens: ['MYSQL', 'PUBLIC', 'KEY'] → 'key' 없으므로 configmap
//     "MYSQL_PASSWORD"   → tokens: ['MYSQL', 'PASSWORD']      → 'password' 있으므로 secret
//     "OPENAI_API_KEY"   → tokens: ['OPENAI', 'API', 'KEY'],
//                          연속 토큰 "api_key" 포함 → secret
//
// PDF §6.3 주의사항:
//   비밀번호가 포함된 조합 URI(MONGODB_URI, DATABASE_URL 등)를 value: 평문으로 ConfigMap에
//   넣으면 Secret 격리 효과가 사라진다. 따라서 URI 키 자체를 Secret으로 분류한다.
//
//   URI_SENSITIVE_KEYS: 비밀번호가 포함될 수 있는 URI 환경변수 키 (완전 일치)
const URI_SENSITIVE_KEYS = new Set([
  'mongodb_uri', 'mongo_uri', 'spring_data_mongodb_uri',  // MongoDB 연결 URI (user:pass 포함)
  'database_url',                                          // Flask/Django/Node PostgreSQL·MySQL URI (user:pass 포함)
  'spring_datasource_url',                                 // Spring Boot JDBC URL (비밀번호 포함 가능)
  'redis_url',                                             // Redis 연결 URI (redis://:password@host)
  // elasticsearch_url 제외: http://host:9200 형식으로 비밀번호 없음 → ConfigMap
  'amqp_url', 'rabbitmq_url',                             // 메시지 브로커 URI (user:pass 포함)
  'mongodb_connection_string', 'mongo_connection_string', // MongoDB 연결 문자열
])

function isSensitiveKey(key) {
  const lower = key.toLowerCase()

  // ── URI 완전 일치 먼저 체크 (PDF §6.3) ──────────────
  // 비밀번호가 포함된 연결 URI는 키 이름만으로는 토큰 매칭이 안 되므로 별도 처리
  if (URI_SENSITIVE_KEYS.has(lower)) return true

  const tokens = lower.split('_')

  // ── 단일 키워드 토큰 단위 매칭 ──────────────────────
  const singleMatches = ['password', 'secret', 'token', 'auth', 'credential', 'jwt']
  if (tokens.some(t => singleMatches.includes(t))) return true

  // ── 복합 키워드 (인접 2-토큰 조합) 매칭 ─────────────
  const compoundMatches = ['api_key', 'private_key']
  for (let i = 0; i < tokens.length - 1; i++) {
    const pair = `${tokens[i]}_${tokens[i + 1]}`
    if (compoundMatches.includes(pair)) return true
  }

  return false
}

// ── 기본값 탐지 (보안 경고용) ─────────────────────────
const WEAK_VALUES = new Set([
  'password', '1234', '12345', '123456', 'admin', 'root',
  'test', 'qwerty', 'abc123', 'changeme', 'secret', '',
])

// ════════════════════════════════════════════════════════
//  1. 환경변수 분류 (ConfigMap vs Secret)
// ════════════════════════════════════════════════════════

/**
 * 환경변수 키가 민감한지 판단 (PDF §9.1)
 * 1순위: ENV_SPEC[svcType].provides[key].category 값 (호출부에서 직접 사용)
 * 2순위: isSensitiveKey() 키워드 매칭 (fallback — 이 함수)
 * @param {string} key
 * @returns {'secret' | 'configmap'}
 */
export function categorizeEnvVar(key) {
  return isSensitiveKey(key) ? 'secret' : 'configmap'
}

/**
 * 서비스의 env 객체를 ConfigMap 항목과 Secret 항목으로 분리
 * Next.js의 NEXT_PUBLIC_ 변수는 빌드 시점에 Docker ARG로 주입되므로
 * ConfigMap/Secret 어디에도 포함하지 않고 buildTimeEntries로 분리 (NF-13 정합성)
 *
 * @param {Record<string, string>} env
 * @param {string} [svcType] - 서비스 타입 (nextjs일 때 NEXT_PUBLIC_ 분리)
 * @returns {{ configEntries: [string, string][], secretEntries: [string, string][], buildTimeEntries: [string, string][] }}
 */
export function splitEnvEntries(env = {}, svcType = '') {
  const configEntries = []
  const secretEntries = []
  const buildTimeEntries = []

  Object.entries(env).forEach(([k, v]) => {
    // Next.js NEXT_PUBLIC_ 변수: 빌드 시점에 Docker ARG로 주입됨
    // ConfigMap에 넣으면 런타임에 변경 가능하다는 잘못된 인상을 줌
    // Secret에 넣으면 빌드 시점에 주입이 안 되는 문제 발생
    if (svcType === 'nextjs' && k.startsWith('NEXT_PUBLIC_')) {
      buildTimeEntries.push([k, v])
      return
    }

    if (categorizeEnvVar(k) === 'secret') {
      secretEntries.push([k, v])
    } else {
      configEntries.push([k, v])
    }
  })

  return { configEntries, secretEntries, buildTimeEntries }
}

// ════════════════════════════════════════════════════════
//  2. 서비스 유형별 필수 환경변수 스펙
//     사용자가 의존성을 선택하면 자동으로 슬롯이 생성됨
// ════════════════════════════════════════════════════════

/**
 * 서비스 타입 → 연결 시 필요한 환경변수 슬롯
 * provides: 이 서비스가 제공하는 값
 * requires: 다른 서비스에 연결될 때 이 서비스가 받아야 하는 값
 */
export const ENV_SPEC = {
  mysql: {
    provides: {
      MYSQL_ROOT_PASSWORD: { category: 'secret', hint: 'MySQL root 비밀번호' },
      MYSQL_DATABASE: { category: 'configmap', hint: 'DB 이름' },
      MYSQL_USER: { category: 'configmap', hint: '일반 사용자명' },
      MYSQL_PASSWORD: { category: 'secret', hint: '일반 사용자 비밀번호' },
    },
    host: (svcName) => svcName,
    port: 3306,
  },
  mongodb: {
    provides: {
      MONGO_INITDB_ROOT_USERNAME: { category: 'configmap', hint: 'MongoDB root 사용자명' },
      MONGO_INITDB_ROOT_PASSWORD: { category: 'secret', hint: 'MongoDB root 비밀번호' },
      MONGO_INITDB_DATABASE: { category: 'configmap', hint: '초기 DB 이름' },
    },
    host: (svcName) => svcName,
    port: 27017,
  },
  redis: {
    provides: {
      REDIS_PASSWORD: { category: 'secret', hint: 'Redis 비밀번호 (선택)' },
    },
    host: (svcName) => svcName,
    port: 6379,
  },
  postgresql: {
    provides: {
      POSTGRES_DB: { category: 'configmap', hint: 'DB 이름' },
      POSTGRES_USER: { category: 'configmap', hint: '사용자명' },
      POSTGRES_PASSWORD: { category: 'secret', hint: '비밀번호' },
    },
    host: (svcName) => svcName,
    port: 5432,
  },
  elasticsearch: {
    provides: {
      ELASTIC_PASSWORD: { category: 'secret', hint: 'elastic 슈퍼유저 비밀번호' },
      ES_JAVA_OPTS: { category: 'configmap', hint: 'JVM 힙 설정 (예: -Xms512m -Xmx512m)' },
      'discovery.type': { category: 'configmap', hint: '단일 노드 설정 값: single-node' },
    },
    host: (svcName) => svcName,
    port: 9200,
  },
}

/**
 * 백엔드가 특정 DB 서비스를 사용할 때 필요한 환경변수 생성 규칙
 * generates: (srcSvcName, srcEnv) => 생성될 env 키/값 쌍
 */
export const CONNECTION_RULES = {
  'spring-boot': {
    mysql: {
      generates: (dbName, dbEnv) => ({
        SPRING_DATASOURCE_URL: `jdbc:mysql://${dbName}:3306/${dbEnv.MYSQL_DATABASE || ''}`,
        SPRING_DATASOURCE_USERNAME: dbEnv.MYSQL_USER || '',
        SPRING_DATASOURCE_PASSWORD: dbEnv.MYSQL_PASSWORD || '',
        SPRING_JPA_HIBERNATE_DDL_AUTO: 'update',
      }),
    },
    postgresql: {
      generates: (dbName, dbEnv) => ({
        SPRING_DATASOURCE_URL: `jdbc:postgresql://${dbName}:5432/${dbEnv.POSTGRES_DB || ''}`,
        SPRING_DATASOURCE_USERNAME: dbEnv.POSTGRES_USER || '',
        SPRING_DATASOURCE_PASSWORD: dbEnv.POSTGRES_PASSWORD || '',
        SPRING_JPA_HIBERNATE_DDL_AUTO: 'update',
        SPRING_JPA_DATABASE_PLATFORM: 'org.hibernate.dialect.PostgreSQLDialect',
      }),
    },
    redis: {
      generates: (dbName, dbEnv) => ({
        SPRING_REDIS_HOST: dbName,
        SPRING_REDIS_PORT: '6379',
        SPRING_REDIS_PASSWORD: dbEnv.REDIS_PASSWORD || '',
      }),
    },
    mongodb: {
      generates: (dbName, dbEnv) => ({
        SPRING_DATA_MONGODB_URI: `mongodb://${dbEnv.MONGO_INITDB_ROOT_USERNAME || ''}:${dbEnv.MONGO_INITDB_ROOT_PASSWORD || ''}@${dbName}:27017/${dbEnv.MONGO_INITDB_DATABASE || ''}?authSource=admin`,
      }),
    },
    elasticsearch: {
      generates: (dbName, dbEnv) => ({
        SPRING_ELASTICSEARCH_URIS: `http://${dbName}:9200`,
        SPRING_ELASTICSEARCH_USERNAME: 'elastic',
        SPRING_ELASTICSEARCH_PASSWORD: dbEnv.ELASTIC_PASSWORD || '',
      }),
    },
  },
  'node-backend': {
    mysql: {
      generates: (dbName, dbEnv) => ({
        DB_HOST: dbName,
        DB_PORT: '3306',
        DB_NAME: dbEnv.MYSQL_DATABASE || '',
        DB_USER: dbEnv.MYSQL_USER || '',
        DB_PASSWORD: dbEnv.MYSQL_PASSWORD || '',
      }),
    },
    postgresql: {
      generates: (dbName, dbEnv) => ({
        DATABASE_URL: `postgresql://${dbEnv.POSTGRES_USER || ''}:${dbEnv.POSTGRES_PASSWORD || ''}@${dbName}:5432/${dbEnv.POSTGRES_DB || ''}`,
        DB_HOST: dbName,
        DB_PORT: '5432',
        DB_NAME: dbEnv.POSTGRES_DB || '',
        DB_USER: dbEnv.POSTGRES_USER || '',
        DB_PASSWORD: dbEnv.POSTGRES_PASSWORD || '',
      }),
    },
    mongodb: {
      generates: (dbName, dbEnv) => ({
        MONGODB_URI: `mongodb://${dbEnv.MONGO_INITDB_ROOT_USERNAME || ''}:${dbEnv.MONGO_INITDB_ROOT_PASSWORD || ''}@${dbName}:27017/${dbEnv.MONGO_INITDB_DATABASE || ''}?authSource=admin`,
      }),
    },
    redis: {
      generates: (dbName, dbEnv) => ({
        REDIS_HOST: dbName,
        REDIS_PORT: '6379',
        REDIS_PASSWORD: dbEnv.REDIS_PASSWORD || '',
      }),
    },
    elasticsearch: {
      generates: (dbName, dbEnv) => ({
        ELASTICSEARCH_HOST: `http://${dbName}:9200`,
        ELASTICSEARCH_USERNAME: 'elastic',
        ELASTICSEARCH_PASSWORD: dbEnv.ELASTIC_PASSWORD || '',
      }),
    },
  },
  'python-flask': {
    mysql: {
      generates: (dbName, dbEnv) => ({
        DATABASE_URL: `mysql+pymysql://${dbEnv.MYSQL_USER || ''}:${dbEnv.MYSQL_PASSWORD || ''}@${dbName}:3306/${dbEnv.MYSQL_DATABASE || ''}`,
      }),
    },
    postgresql: {
      generates: (dbName, dbEnv) => ({
        DATABASE_URL: `postgresql://${dbEnv.POSTGRES_USER || ''}:${dbEnv.POSTGRES_PASSWORD || ''}@${dbName}:5432/${dbEnv.POSTGRES_DB || ''}`,
      }),
    },
    mongodb: {
      generates: (dbName, dbEnv) => ({
        MONGO_URI: `mongodb://${dbEnv.MONGO_INITDB_ROOT_USERNAME || ''}:${dbEnv.MONGO_INITDB_ROOT_PASSWORD || ''}@${dbName}:27017/${dbEnv.MONGO_INITDB_DATABASE || ''}?authSource=admin`,
      }),
    },
    redis: {
      generates: (dbName, dbEnv) => ({
        REDIS_HOST: dbName,
        REDIS_PORT: '6379',
        REDIS_PASSWORD: dbEnv.REDIS_PASSWORD || '',
      }),
    },
    elasticsearch: {
      generates: (dbName, dbEnv) => ({
        ELASTICSEARCH_URL: `http://${dbName}:9200`,
        ELASTICSEARCH_USERNAME: 'elastic',
        ELASTICSEARCH_PASSWORD: dbEnv.ELASTIC_PASSWORD || '',
      }),
    },
  },
  // ── Next.js (API Routes에서 DB 직접 연결 가능) ─────────
  // node-backend와 유사한 연결 규칙 사용
  // NEXT_PUBLIC_ 접두사 환경변수는 클라이언트 번들에 포함되므로 주의
  'nextjs': {
    mysql: {
      generates: (dbName, dbEnv) => ({
        DB_HOST: dbName,
        DB_PORT: '3306',
        DB_NAME: dbEnv.MYSQL_DATABASE || '',
        DB_USER: dbEnv.MYSQL_USER || '',
        DB_PASSWORD: dbEnv.MYSQL_PASSWORD || '',
      }),
    },
    postgresql: {
      generates: (dbName, dbEnv) => ({
        DATABASE_URL: `postgresql://${dbEnv.POSTGRES_USER || ''}:${dbEnv.POSTGRES_PASSWORD || ''}@${dbName}:5432/${dbEnv.POSTGRES_DB || ''}`,
        DB_HOST: dbName,
        DB_PORT: '5432',
        DB_NAME: dbEnv.POSTGRES_DB || '',
        DB_USER: dbEnv.POSTGRES_USER || '',
        DB_PASSWORD: dbEnv.POSTGRES_PASSWORD || '',
      }),
    },
    mongodb: {
      generates: (dbName, dbEnv) => ({
        MONGODB_URI: `mongodb://${dbEnv.MONGO_INITDB_ROOT_USERNAME || ''}:${dbEnv.MONGO_INITDB_ROOT_PASSWORD || ''}@${dbName}:27017/${dbEnv.MONGO_INITDB_DATABASE || ''}?authSource=admin`,
      }),
    },
    redis: {
      generates: (dbName, dbEnv) => ({
        REDIS_HOST: dbName,
        REDIS_PORT: '6379',
        REDIS_PASSWORD: dbEnv.REDIS_PASSWORD || '',
      }),
    },
    elasticsearch: {
      generates: (dbName, dbEnv) => ({
        ELASTICSEARCH_HOST: `http://${dbName}:9200`,
        ELASTICSEARCH_USERNAME: 'elastic',
        ELASTICSEARCH_PASSWORD: dbEnv.ELASTIC_PASSWORD || '',
      }),
    },
  },
}

// ════════════════════════════════════════════════════════
//  3. 환경변수 자동 전파
//     서비스 목록을 받아서 의존성 기반으로 env를 자동 완성
// ════════════════════════════════════════════════════════

/**
 * 서비스 목록에서 의존성 기반으로 환경변수를 자동 전파
 * @param {Array} services - useStore의 services 배열
 * @returns {Array} env가 보강된 서비스 배열
 */
export function propagateEnvVars(services) {
  // 이름 → 서비스 맵
  const svcMap = Object.fromEntries(services.map(s => [s.name, s]))

  return services.map(svc => {
    const extraEnv = {}

    // ── Elasticsearch 기본 환경변수 자동 주입 ───────────
    // single-node 설정과 JVM 힙 설정이 없으면 컨테이너가 시작 직후 OOM으로 종료됨
    if (svc.type === 'elasticsearch') {
      if (!svc.env?.['discovery.type']) {
        extraEnv['discovery.type'] = 'single-node'
      }
      if (!svc.env?.ES_JAVA_OPTS) {
        // memReq 기준으로 힙 크기 자동 계산 (memReq의 50%)
        const memReqStr = svc.memReq || '1Gi'
        const memMiB = memReqStr.endsWith('Gi')
          ? parseFloat(memReqStr) * 1024
          : parseFloat(memReqStr)
        const heapMiB = Math.floor(memMiB * 0.5)
        extraEnv['ES_JAVA_OPTS'] = `-Xms${heapMiB}m -Xmx${heapMiB}m`
      }
    }

    const rules = CONNECTION_RULES[svc.type]
    if (!rules) {
      // CONNECTION_RULES가 없어도 extraEnv(ES 기본값 등)는 반영
      if (Object.keys(extraEnv).length === 0) return svc
      return { ...svc, env: { ...extraEnv, ...(svc.env || {}) } }
    }

    // 이 서비스가 의존하는 서비스들을 순회
    for (const depName of (svc.deps || [])) {
      const depSvc = svcMap[depName]
      if (!depSvc) continue

      const rule = rules[depSvc.type]
      if (!rule) continue

      // 의존 서비스의 env를 기반으로 연결 환경변수 생성
      const generated = rule.generates(depName, depSvc.env || {})
      Object.assign(extraEnv, generated)
    }

    // 기존 env와 병합 (사용자가 직접 설정한 값이 우선)
    return {
      ...svc,
      env: { ...extraEnv, ...(svc.env || {}) },
    }
  })
}

// ════════════════════════════════════════════════════════
//  4. 환경변수 일관성 검증
// ════════════════════════════════════════════════════════

/**
 * @typedef {Object} EnvIssue
 * @property {'error' | 'warning'} severity
 * @property {string} svcName
 * @property {string} key
 * @property {string} message
 * @property {string} suggestion
 */

/**
 * 서비스 목록의 환경변수 일관성을 검증
 * @param {Array} services
 * @returns {EnvIssue[]}
 */
export function validateEnvVars(services) {
  const issues = []
  const svcMap = Object.fromEntries(services.map(s => [s.name, s]))

  services.forEach(svc => {
    const env = svc.env || {}

    // ── 검증 1: 비밀번호 빈값 차단 ────────────────────
    Object.entries(env).forEach(([k, v]) => {
      if (isSensitiveKey(k) && (!v || String(v).trim() === '')) {
        issues.push({
          severity: 'error',
          svcName: svc.name,
          key: k,
          message: `[${svc.name}] ${k}가 비어 있습니다`,
          suggestion: '비밀번호를 입력하세요. 빈 값으로는 컨테이너가 시작되지 않을 수 있습니다.',
        })
      }
    })

    // ── 검증 2: 기본값(약한 비밀번호) 경고 ────────────
    Object.entries(env).forEach(([k, v]) => {
      if (isSensitiveKey(k) && WEAK_VALUES.has(String(v).toLowerCase())) {
        issues.push({
          severity: 'warning',
          svcName: svc.name,
          key: k,
          message: `[${svc.name}] ${k}에 취약한 기본값 사용`,
          suggestion: '실제 운영에서는 복잡한 비밀번호를 사용하세요. (예: openssl rand -base64 32)',
        })
      }
    })

    // ── 검증 3: 의존 서비스와의 DB 연결 정보 일관성 ───
    const rules = CONNECTION_RULES[svc.type]
    if (!rules) return

    for (const depName of (svc.deps || [])) {
      const depSvc = svcMap[depName]
      if (!depSvc) continue

      const depEnv = depSvc.env || {}

      // MySQL 연결 정보 일관성
      if (depSvc.type === 'mysql') {
        // URL에서 DB명 추출해서 MYSQL_DATABASE와 비교
        const url = env.SPRING_DATASOURCE_URL || env.DATABASE_URL || ''
        const urlDb = url.match(/\/([^/?]+)(\?|$)/)?.[1]
        const mysqlDb = depEnv.MYSQL_DATABASE

        if (urlDb && mysqlDb && urlDb !== mysqlDb) {
          const urlKey = env.SPRING_DATASOURCE_URL ? 'SPRING_DATASOURCE_URL' : 'DATABASE_URL'
          const urlSuggestion = svc.type === 'spring-boot'
            ? `URL을 jdbc:mysql://${depName}:3306/${mysqlDb}으로 수정하세요.`
            : `URL의 DB명을 ${mysqlDb}으로 수정하세요.`
          issues.push({
            severity: 'error',
            svcName: svc.name,
            key: urlKey,
            message: `[${svc.name}] DB명 불일치: URL의 "${urlDb}" ≠ MySQL의 "${mysqlDb}"`,
            suggestion: urlSuggestion,
          })
        }

        // 비밀번호 일관성
        const svcPass = env.SPRING_DATASOURCE_PASSWORD || env.DB_PASSWORD || ''
        const dbPass = depEnv.MYSQL_PASSWORD || ''
        if (svcPass && dbPass && svcPass !== dbPass) {
          const passKey = env.SPRING_DATASOURCE_PASSWORD ? 'SPRING_DATASOURCE_PASSWORD' : 'DB_PASSWORD'
          issues.push({
            severity: 'error',
            svcName: svc.name,
            key: passKey,
            message: `[${svc.name}] 비밀번호가 ${depName}의 MYSQL_PASSWORD와 다릅니다`,
            suggestion: '두 값을 동일하게 맞추세요.',
          })
        }
      }

      // PostgreSQL 연결 정보 일관성
      if (depSvc.type === 'postgresql') {
        const url = env.SPRING_DATASOURCE_URL || env.DATABASE_URL || ''
        const urlDb = url.match(/\/([^/?]+)(\?|$)/)?.[1]
        const pgDb = depEnv.POSTGRES_DB

        if (urlDb && pgDb && urlDb !== pgDb) {
          const urlKey = env.SPRING_DATASOURCE_URL ? 'SPRING_DATASOURCE_URL' : 'DATABASE_URL'
          const urlSuggestion = svc.type === 'spring-boot'
            ? `URL을 jdbc:postgresql://${depName}:5432/${pgDb}으로 수정하세요.`
            : `URL의 DB명을 ${pgDb}으로 수정하세요.`
          issues.push({
            severity: 'error',
            svcName: svc.name,
            key: urlKey,
            message: `[${svc.name}] DB명 불일치: URL의 "${urlDb}" ≠ PostgreSQL의 "${pgDb}"`,
            suggestion: urlSuggestion,
          })
        }

        const svcPass = env.SPRING_DATASOURCE_PASSWORD || env.DB_PASSWORD || ''
        const pgPass = depEnv.POSTGRES_PASSWORD || ''
        if (svcPass && pgPass && svcPass !== pgPass) {
          const passKey = env.SPRING_DATASOURCE_PASSWORD ? 'SPRING_DATASOURCE_PASSWORD' : 'DB_PASSWORD'
          issues.push({
            severity: 'error',
            svcName: svc.name,
            key: passKey,
            message: `[${svc.name}] 비밀번호가 ${depName}의 POSTGRES_PASSWORD와 다릅니다`,
            suggestion: '두 값을 동일하게 맞추세요.',
          })
        }
      }

      // MongoDB URI 일관성
      if (depSvc.type === 'mongodb') {
        const uri = env.MONGODB_URI || env.MONGO_URI || env.SPRING_DATA_MONGODB_URI || ''
        if (uri && !uri.includes(depName)) {
          issues.push({
            severity: 'warning',
            svcName: svc.name,
            key: 'MONGODB_URI',
            message: `[${svc.name}] MongoDB URI에 호스트명 "${depName}"이 없습니다`,
            suggestion: `URI에 @${depName}:27017 형식으로 호스트를 포함하세요.`,
          })
        }
      }

      // Elasticsearch 연결 정보 일관성
      if (depSvc.type === 'elasticsearch') {
        // ELASTIC_PASSWORD 일관성
        const svcPass = env.SPRING_ELASTICSEARCH_PASSWORD
          || env.ELASTICSEARCH_PASSWORD || ''
        const esPass = depEnv.ELASTIC_PASSWORD || ''
        if (svcPass && esPass && svcPass !== esPass) {
          issues.push({
            severity: 'error',
            svcName: svc.name,
            key: 'ELASTICSEARCH_PASSWORD',
            message: `[${svc.name}] Elasticsearch 비밀번호가 ${depName}의 ELASTIC_PASSWORD와 다릅니다`,
            suggestion: '두 값을 동일하게 맞추세요.',
          })
        }
        // ES_JAVA_OPTS 힙 설정 누락 경고
        if (!depEnv.ES_JAVA_OPTS) {
          issues.push({
            severity: 'warning',
            svcName: depName,
            key: 'ES_JAVA_OPTS',
            message: `[${depName}] ES_JAVA_OPTS 미설정 — OOM 위험`,
            suggestion: '-Xms512m -Xmx512m 처럼 힙 크기를 명시하세요. memReq의 50% 이하 권장.',
          })
        }
      }
    }

    // ── 검증 4: AI API 키가 프론트엔드/nginx 서비스에 노출되면 차단 ─
    // react-nginx: 빌드된 React 앱이 번들에 환경변수를 포함할 수 있음
    // nginx: 리버스 프록시 설정에 API 키가 들어가는 경우 방지
    if (svc.type === 'react-nginx' || svc.type === 'nginx') {
      const dangerousKeys = Object.keys(env).filter(k =>
        /openai|anthropic|api_key|gpt/i.test(k)
      )
      dangerousKeys.forEach(k => {
        issues.push({
          severity: 'error',
          svcName: svc.name,
          key: k,
          message: `[${svc.name}] AI API 키가 ${svc.type === 'react-nginx' ? '프론트엔드' : 'nginx'}에 노출됩니다`,
          suggestion: 'API 키는 백엔드(Flask, Node.js 등)에만 주입하세요. 프론트엔드/프록시에서 직접 호출은 키 탈취 위험이 있습니다.',
        })
      })
    }

    // ── 검증 5 [VE-09]: Next.js NEXT_PUBLIC_ 접두사로 민감 정보 노출 차단 ─
    // PDF §22 VE-09: AI API 키가 프론트엔드에 노출되면 ERROR
    // NEXT_PUBLIC_ 접두사가 붙은 환경변수는 빌드 시 JS 번들에 인라인됨
    // → 브라우저에서 소스코드로 즉시 열람 가능 → 키 탈취 위험
    // isSensitiveKey() 함수와 동일한 기준으로 민감 여부 판별
    if (svc.type === 'nextjs') {
      const publicSensitiveKeys = Object.keys(env).filter(k =>
        k.startsWith('NEXT_PUBLIC_') && isSensitiveKey(k)
      )
      publicSensitiveKeys.forEach(k => {
        issues.push({
          severity: 'error',
          svcName: svc.name,
          key: k,
          rule: 'VE-09',
          message: `[${svc.name}] NEXT_PUBLIC_ 접두사로 민감 정보가 브라우저에 노출됩니다 (VE-09)`,
          suggestion:
            `${k}에서 NEXT_PUBLIC_ 접두사를 제거하세요. ` +
            '이 변수는 빌드 시 JS 번들에 인라인되어 브라우저 개발자 도구에서 즉시 확인 가능합니다. ' +
            '서버 사이드(API Routes)에서만 접근하도록 변경하세요.',
        })
      })

      // ── 검증 6 [VE-10]: 빌드 시점 변수 참조 무결성 ────────
      // PDF §23 VE-10: 참조 대상이 치환되지 않는 경우 ERROR
      // NEXT_PUBLIC_ 변수는 Docker 빌드 시 ARG로 전달됨
      // 값이 비어있으면 빌드 결과물에서 undefined가 됨 → ERROR
      // 값이 있으면 빌드 시점 주입 안내 → WARNING
      const publicKeys = Object.keys(env).filter(k =>
        k.startsWith('NEXT_PUBLIC_') && !publicSensitiveKeys.includes(k)
      )
      const emptyPublicKeys = publicKeys.filter(k => !env[k] || String(env[k]).trim() === '')
      const filledPublicKeys = publicKeys.filter(k => env[k] && String(env[k]).trim() !== '')

      emptyPublicKeys.forEach(k => {
        issues.push({
          severity: 'error',
          svcName: svc.name,
          key: k,
          rule: 'VE-10',
          message: `[${svc.name}] ${k} 값이 비어 있어 빌드 후 클라이언트에서 undefined가 됩니다 (VE-10)`,
          suggestion:
            '이 변수는 Docker 빌드 시 JS 번들에 인라인됩니다. ' +
            '빈 값이면 클라이언트 코드에서 undefined로 참조되어 런타임 오류가 발생합니다. ' +
            '값을 입력하거나, CI의 GitHub Variables에 등록하세요.',
        })
      })

      if (filledPublicKeys.length > 0) {
        issues.push({
          severity: 'warning',
          svcName: svc.name,
          key: 'NEXT_PUBLIC_*',
          message: `[${svc.name}] NEXT_PUBLIC_ 변수 ${filledPublicKeys.length}개는 빌드 시점에 주입됩니다`,
          suggestion:
            'NEXT_PUBLIC_ 변수는 Docker 빌드 시 ARG로 전달되어 JS 번들에 인라인됩니다. ' +
            'ConfigMap으로 런타임에 변경할 수 없으며, 값을 변경하려면 이미지를 다시 빌드해야 합니다. ' +
            `대상: ${filledPublicKeys.join(', ')}`,
        })
      }

      // ── 검증 7: PORT 환경변수 수동 설정 시 포트 충돌 경고 ─
      // Dockerfile에서 ENV PORT={port}를 설정하고, K8s containerPort와 Probe도 같은 값 사용
      // 사용자가 PORT를 직접 env에 넣으면 Dockerfile 값과 충돌 가능
      if (env.PORT !== undefined) {
        const expectedPort = String(svc.port || 3000)
        if (env.PORT !== expectedPort) {
          issues.push({
            severity: 'error',
            svcName: svc.name,
            key: 'PORT',
            message: `[${svc.name}] PORT 환경변수(${env.PORT})가 서비스 포트(${expectedPort})와 다릅니다`,
            suggestion:
              `PORT를 ${expectedPort}으로 변경하거나, 서비스 포트 설정을 ${env.PORT}으로 맞추세요. ` +
              'Dockerfile의 PORT, containerPort, Probe 포트가 모두 일치해야 Pod가 정상 동작합니다.',
          })
        } else {
          issues.push({
            severity: 'warning',
            svcName: svc.name,
            key: 'PORT',
            message: `[${svc.name}] PORT 환경변수를 수동 설정할 필요가 없습니다`,
            suggestion:
              'PORT는 Dockerfile에서 자동 설정됩니다. 환경변수에서 제거해도 됩니다.',
          })
        }
      }
    }
  })

  return issues
}

// ════════════════════════════════════════════════════════
//  5. 파일 분리 빌드 (GitHub Push용 파일 목록 생성)
//
//  ⚠️  Sealed Secrets는 MVP 범위 외 (PDF ADR-003 §12)
//      Phase 2 확장 항목 — MVP 보안 모델: .gitignore + secrets.example.yaml (NF-13)
// ════════════════════════════════════════════════════════

/**
 * ConfigMap YAML 생성 (분리된 파일)
 * Next.js의 NEXT_PUBLIC_ 변수는 빌드 시점 ARG로 주입되므로 ConfigMap에 포함되지 않음
 */
export function genConfigMapFile(svc, ns) {
  const { configEntries, buildTimeEntries } = splitEnvEntries(svc.env || {}, svc.type)
  // NEXT_PUBLIC_ 변수가 있으면 ConfigMap에 안내 주석 추가
  const buildTimeComment = buildTimeEntries.length > 0
    ? `\n  # ── 빌드 시점 변수 (Docker ARG로 주입, ConfigMap에 미포함) ──\n`
    + buildTimeEntries.map(([k]) => `  # ${k} \u2192 Docker build --build-arg ${k}=...`).join('\n')
    : ''
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${svc.name}-config
  namespace: ${ns}
  labels:
    app: ${svc.name}
    app.kubernetes.io/managed-by: grad-deploy
data:
${configEntries.length
      ? configEntries.map(([k, v]) => `  ${k}: "${v}"`).join('\n')
      : '  # 설정값 없음'}${buildTimeComment}`
}

export function resolveGithubSecretName(k, svc) {
  return k.toUpperCase()
}

/**
 * Secret YAML 생성 (GitHub Actions Secrets 참조 방식 — NF-13)
 * .gitignore로 보호되며 실제 값은 GitHub Actions Secrets에서 주입
 * Next.js NEXT_PUBLIC_ 변수는 Secret이 아닌 Docker ARG로 주입되므로 제외
 */
export function genSecretFile(svc, ns) {
  const { secretEntries } = splitEnvEntries(svc.env || {}, svc.type)
  if (!secretEntries.length) return null
  const b64 = v => btoa(unescape(encodeURIComponent(String(v))))
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${svc.name}-secret
  namespace: ${ns}
  labels:
    app: ${svc.name}
    app.kubernetes.io/managed-by: grad-deploy
type: Opaque
data:
${secretEntries.map(([k, v]) => `  ${k}: ${b64(v)}`).join('\n')}`
}

/**
 * 전체 서비스에 대한 파일 목록을 생성
 * { 경로: 내용 } 형태로 반환 → DeployPanel의 ghPushFiles에 전달
 *
 * @param {Array}  services
 * @param {string} ns
 * @param {string} netPolicyYaml  - genNetworkPolicies()의 결과
 * @param {string} ciYaml         - genGitHubActions()의 결과
 * @param {string} argoYaml       - genArgoCDApp()의 결과
 * @param {string} [proj='my-app'] - 프로젝트명 (buildAllFiles의 proj와 반드시 동일)
 *
 * 경로 규칙 (buildAllFiles와 일치):
 *   서비스 매니페스트: k8s/projects/<proj>/services/<svc>/
 *   overlay:          k8s/projects/<proj>/overlays/production/
 *   ArgoCD app:       k8s/projects/<proj>/argo-app.yaml
 *
 * kustomization 상대경로 (overlays/production/ 기준):
 *   ../../services/<svc>  (services/ 폴더가 overlays/production/ 과 같은 레벨에 있음)
 */
export function buildFileMap(services, ns, netPolicyYaml, ciYaml, argoYaml, proj = 'my-app') {
  const files = {}

  // ── 경로 루트 계산 (buildAllFiles의 projRoot/svcRoot/overlayDir 와 동일하게 유지)
  const projRoot = ['k8s', 'projects', proj].join('/')
  const overlayDir = getOverlayPath(proj)

  // ── 서비스별 파일 ──────────────────────────────────────
  services.forEach(svc => {
    // [변경] 경로 헬퍼 함수를 사용하여 경로 불일치 원천 차단
    const base = getServicePath(proj, svc.name)

    // ConfigMap (항상 push)
    files[[base, 'configmap.yaml'].join('/')] = genConfigMapFile(svc, ns)

    // Secret: GitHub Actions Secrets 참조 방식 (.gitignore 보호)
    // ⚠️ Sealed Secrets는 Phase 2 — MVP는 .gitignore + secrets.example.yaml (NF-13)
    const secretYaml = genSecretFile(svc, ns)
    if (secretYaml) {
      files[[base, 'secret.example.yaml'].join('/')] = secretYaml
    }

    // kustomization.yaml (서비스 폴더 내 base kustomization)
    // nginx/react-nginx 타입은 nginx-conf.yaml도 포함
    //
    // ⚠️ [sync 버그 수정] sealed-secret.yaml 은 더 이상 resources 에 추가하지 않는다.
    //   기존: hasSecret 이면 'sealed-secret.yaml' 을 참조했으나, 이 파일은
    //   Git 에 커밋되지 않으므로(평문 Secret 커밋 금지 + 봉인은 클러스터에서만 가능)
    //   ArgoCD 가 `kustomize build` 시 "no such file or directory" 로 실패 →
    //   Application 이 ComparisonError 로 sync 되지 않는 원인이었다.
    //   → Secret 은 부트스트랩 단계에서 `kubectl create secret` 으로 직접 생성하고
    //     deployment.yaml 의 envFrom.secretRef 는 optional: true 로 참조한다.
    const isNginxType = (svc.type === 'nginx' || svc.type === 'react-nginx')
    const resources = ['deployment.yaml', 'service.yaml', 'configmap.yaml']
    if (isNginxType) resources.push('nginx-conf.yaml')
    files[[base, 'kustomization.yaml'].join('/')] = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
${resources.map(r => `  - ${r}`).join('\n')}`
  })

  // ── overlay: networkpolicy ────────────────────────────
  // [변경] 구 경로 k8s/overlays/production/ → 신 경로 overlayDir
  files[[overlayDir, 'networkpolicy.yaml'].join('/')] = netPolicyYaml

  // ── overlay: kustomization.yaml ───────────────────────
  // 상대경로 계산:
  //   이 파일 위치 = k8s/projects/<proj>/overlays/production/kustomization.yaml
  //   서비스 위치  = k8s/projects/<proj>/services/<svc>/
  //   overlays/production/ → ../../services/<svc>
  // [변경] 구 경로 ../../base/<svc> → 신 경로 ../../services/<svc>
  const imageNameOf = name => name.replace(/-svc$/, '-service-v2')
  files[[overlayDir, 'kustomization.yaml'].join('/')] = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${ns}
resources:
${services.map(s => `  - ../../services/${s.name}`).join('\n')}
  - networkpolicy.yaml
images:
${services.map(s => `  - name: ${s.name}
    newName: ${imageNameOf(s.name)}
    newTag: latest`).join('\n')}`

  // ── CI 파이프라인 파일 (.github/workflows) ──────────────
  files[['.github', 'workflows', 'ci-cd.yaml'].join('/')] = ciYaml

  // ── ArgoCD Application (레거시 참조용)  ───────────────
  // [변경] 구 경로 k8s/argo-app.yaml → 신 경로 projRoot/argo-app.yaml
  // buildAllFiles도 같은 경로에 덮어쓰므로 내용은 동일
  files[[projRoot, 'argo-app.yaml'].join('/')] = argoYaml

  // ── .gitignore (Secret 보호) ──────────────────────────
  files['.gitignore'] = generateGitignore()

  return files
}

// ════════════════════════════════════════════════════════
//  6. .gitignore 자동 생성 (NF-13)
// ════════════════════════════════════════════════════════

export function generateGitignore() {
  return `# ── Grad-Deploy 자동 생성 ─────────────────────────────
# 절대 커밋 금지 — 비밀번호·인증 정보

# 평문 Secret 파일 (.gitignore가 자동 보호)
**/secret.yaml
**/*-secret.yaml
**/secrets.yaml
**/*-secrets.yaml

# 환경변수 파일
.env
.env.*
!.env.example

# 로컬 키 파일
*.key
*.pem
*.p12

# IDE
.idea/
.vscode/
*.swp

# OS
.DS_Store
Thumbs.db

# Node
node_modules/

# 빌드 산출물
build/
dist/
target/
`
}

// ════════════════════════════════════════════════════════
//  8. 리소스 합산 + 최소 사양 경고
// ════════════════════════════════════════════════════════

const HEAVY_SERVICES = {
  elasticsearch: { ram: 2048, cpu: 0.5, warning: 'Elasticsearch는 최소 2GB RAM이 필요합니다' },
  kafka: { ram: 1024, cpu: 0.5, warning: 'Kafka는 Zookeeper 포함 최소 1.5GB RAM이 필요합니다' },
}

/**
 * 서비스 목록의 총 리소스를 계산하고 경고 반환
 * @param {Array} services
 * @returns {{ totalRamMi: number, warnings: string[] }}
 */
export function calcResourceWarnings(services) {
  const warnings = []
  let totalRamMi = 0

  services.forEach(svc => {
    const memReq = svc.memReq || ''
    if (memReq.endsWith('Gi')) totalRamMi += parseFloat(memReq) * 1024
    else if (memReq.endsWith('Mi')) totalRamMi += parseFloat(memReq)

    const heavy = HEAVY_SERVICES[svc.type]
    if (heavy) warnings.push(heavy.warning)
  })

  if (totalRamMi > 6 * 1024) {
    warnings.push(`총 메모리 Request가 ${(totalRamMi / 1024).toFixed(1)}GB입니다. RAM 16GB 이상의 환경을 권장합니다.`)
  } else if (totalRamMi > 3 * 1024) {
    warnings.push(`총 메모리 Request가 ${(totalRamMi / 1024).toFixed(1)}GB입니다. RAM 8GB 이상의 환경을 권장합니다.`)
  }

  return { totalRamMi, warnings }
}
