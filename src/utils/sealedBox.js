// ════════════════════════════════════════════════════════
//  GitHub Secrets용 libsodium sealed_box 암호화
//  CDN에서 libsodium-wrappers 동적 로드 (npm 의존성 없이)
// ════════════════════════════════════════════════════════

let cachedSodium = null

async function loadSodium() {
  if (cachedSodium) return cachedSodium

  const mod = await import(
    /* @vite-ignore */
    'https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/+esm'
  )

  // ESM 번들 방식에 따라 실제 sodium이 mod 또는 mod.default에 있음
  const sodium = mod.default ?? mod
  await sodium.ready

  // base64_variants가 정상적으로 로드됐는지 확인
  if (!sodium.base64_variants) {
    throw new Error(
      'libsodium 로드 실패: base64_variants를 찾을 수 없습니다. ' +
      'CDN 연결 또는 브라우저 호환성 문제일 수 있습니다.'
    )
  }

  cachedSodium = sodium
  return sodium
}

/**
 * GitHub Secrets용 값 암호화
 * @param {string} publicKeyB64 - repo public key (base64)
 * @param {string} secretValue  - 평문
 * @returns {Promise<string>}   - base64 암호문
 */
export async function encryptForGithub(publicKeyB64, secretValue) {
  if (!publicKeyB64) {
    throw new Error(
      'Public key가 비어 있습니다. ' +
      'PAT에 repo 스코프(Secrets 쓰기 권한)가 있는지 확인하세요.'
    )
  }
  if (!secretValue) {
    throw new Error('암호화할 값이 비어 있습니다.')
  }

  const sodium = await loadSodium()

  const binKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL)
  const binMsg = sodium.from_string(secretValue)
  const encrypted = sodium.crypto_box_seal(binMsg, binKey)
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL)
}
