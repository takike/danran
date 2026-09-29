/**
 * Cryptographic helpers for Danran authentication and token encryption.
 * Implements WebCrypto AES-256-GCM encryption with versioned envelope,
 * strict canonical base64 key validation, AAD contextual binding, and S256 PKCE challenges.
 */

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const buffer = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToUint8Array(str: string): Uint8Array<ArrayBuffer> {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return base64ToBytes(base64);
}

/**
 * Validates and decodes strict canonical standard base64-encoded 32-byte AES-256 key.
 * Rejects invalid format, padding, characters, non-canonical padding bits, or lengths.
 */
export function parseAes256Key(base64Key: string): Uint8Array<ArrayBuffer> {
  if (typeof base64Key !== 'string') {
    throw new Error('Encryption key must be a string');
  }
  const trimmed = base64Key.trim();
  // Standard base64 encoding of 32 bytes is exactly 44 characters ending with 1 padding '='
  const base64Regex = /^[A-Za-z0-9+/]{43}=$/;
  if (!base64Regex.test(trimmed)) {
    throw new Error('Invalid TOKEN_ENC_KEY: must be strict standard base64 encoding of 32 bytes');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(trimmed);
  } catch {
    throw new Error('Invalid TOKEN_ENC_KEY: base64 decoding failed');
  }
  if (bytes.length !== 32) {
    throw new Error(`Invalid TOKEN_ENC_KEY: expected 32 bytes, got ${bytes.length}`);
  }
  // Canonical base64 check: re-encoding must match trimmed string exactly so nonzero pad bits fail
  if (bytesToBase64(bytes) !== trimmed) {
    throw new Error('Invalid TOKEN_ENC_KEY: non-canonical base64 encoding');
  }
  return bytes;
}

/**
 * Generates cryptographically secure random string in base64url format.
 * Default is 32 random bytes (256-bit entropy).
 */
export function generateRandomToken(byteLength = 32): string {
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  crypto.getRandomValues(bytes);
  return uint8ArrayToBase64Url(bytes);
}

/**
 * Calculates SHA-256 digest formatted as lowercase hex string.
 * Safely copies input into an ArrayBuffer-backed Uint8Array before passing to WebCrypto.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  let bufferSource: BufferSource;
  if (typeof data === 'string') {
    bufferSource = new TextEncoder().encode(data);
  } else {
    const copyBuffer = new ArrayBuffer(data.length);
    const copy = new Uint8Array(copyBuffer);
    copy.set(data);
    bufferSource = copy;
  }
  const digest = await crypto.subtle.digest('SHA-256', bufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Calculates SHA-256 digest formatted as unpadded base64url string.
 * Safely copies input into an ArrayBuffer-backed Uint8Array before passing to WebCrypto.
 */
export async function sha256Base64Url(data: string | Uint8Array): Promise<string> {
  let bufferSource: BufferSource;
  if (typeof data === 'string') {
    bufferSource = new TextEncoder().encode(data);
  } else {
    const copyBuffer = new ArrayBuffer(data.length);
    const copy = new Uint8Array(copyBuffer);
    copy.set(data);
    bufferSource = copy;
  }
  const digest = await crypto.subtle.digest('SHA-256', bufferSource);
  return uint8ArrayToBase64Url(new Uint8Array(digest));
}

/**
 * Computes PKCE code_challenge from code_verifier via S256 method.
 */
export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  return sha256Base64Url(codeVerifier);
}

/**
 * Encrypts plaintext string using AES-256-GCM with fresh 12-byte IV and AAD contextual binding.
 * Output is formatted as a versioned envelope: `v1.<iv_base64url>.<ciphertext_and_tag_base64url>`.
 */
export async function encryptAesGcm(
  plaintext: string,
  base64Key: string,
  aad: string,
): Promise<string> {
  const keyBytes = parseAes256Key(base64Key);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);

  const ivBuffer = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuffer);
  crypto.getRandomValues(iv);

  const encodedPlaintext = new TextEncoder().encode(plaintext);
  const encodedAad = new TextEncoder().encode(aad);

  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encodedAad,
      tagLength: 128,
    },
    cryptoKey,
    encodedPlaintext,
  );

  const ivPart = uint8ArrayToBase64Url(iv);
  const cipherPart = uint8ArrayToBase64Url(new Uint8Array(cipherBuffer));

  return `v1.${ivPart}.${cipherPart}`;
}

/**
 * Decrypts versioned AES-256-GCM envelope using the provided key and matching AAD.
 * Throws on tampering, wrong key, wrong AAD, or invalid envelope without leaking internal details.
 */
export async function decryptAesGcm(
  envelope: string,
  base64Key: string,
  aad: string,
): Promise<string> {
  if (typeof envelope !== 'string') {
    throw new Error('Invalid ciphertext envelope');
  }

  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Unsupported or malformed ciphertext envelope');
  }

  const ivStr = parts[1];
  const cipherStr = parts[2];
  if (!ivStr || !cipherStr) {
    throw new Error('Malformed ciphertext envelope parts');
  }

  let iv: Uint8Array<ArrayBuffer>;
  let cipherBytes: Uint8Array<ArrayBuffer>;
  try {
    iv = base64UrlToUint8Array(ivStr);
    cipherBytes = base64UrlToUint8Array(cipherStr);
  } catch {
    throw new Error('Malformed base64url encoding in ciphertext envelope');
  }

  if (iv.length !== 12) {
    throw new Error('Invalid IV length in ciphertext envelope');
  }

  const keyBytes = parseAes256Key(base64Key);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);

  const encodedAad = new TextEncoder().encode(aad);

  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: encodedAad,
        tagLength: 128,
      },
      cryptoKey,
      cipherBytes,
    );
  } catch {
    // Deliberately generic error to prevent ciphertext oracle / leakage
    throw new Error('Decryption failed: authentication tag mismatch or invalid payload');
  }

  return new TextDecoder().decode(plainBuffer);
}
