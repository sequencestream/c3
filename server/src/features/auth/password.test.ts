import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password hashing (ADR-0023)', () => {
  it('produces a PHC-style $scrypt$ string that is not the plaintext', () => {
    const hash = hashPassword('hunter2')
    expect(hash.startsWith('$scrypt$')).toBe(true)
    expect(hash).not.toContain('hunter2')
  })

  it('salts each hash so the same password hashes differently', () => {
    expect(hashPassword('same-pw')).not.toBe(hashPassword('same-pw'))
  })

  it('verifies the correct password and rejects a wrong one', () => {
    const hash = hashPassword('correct horse')
    expect(verifyPassword('correct horse', hash)).toBe(true)
    expect(verifyPassword('wrong horse', hash)).toBe(false)
    expect(verifyPassword('', hash)).toBe(false)
  })

  it('returns false (never throws) for a malformed hash', () => {
    expect(verifyPassword('pw', 'not-a-hash')).toBe(false)
    expect(verifyPassword('pw', '$bcrypt$x$y$z')).toBe(false)
    expect(verifyPassword('pw', '$scrypt$ln=15$only-three-parts')).toBe(false)
  })
})
