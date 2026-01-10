import crypto from "node:crypto"
import { Buffer } from "node:buffer"

export function aes128EcbDecrypt(keyHex, dataBuf) {
    const key = Buffer.from(keyHex, "hex")
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(dataBuf), decipher.final()])
}

export function aes128CbcDecrypt(keyHex, dataBuf) {
    const key = Buffer.from(keyHex, "hex")
    const iv = Buffer.alloc(16, 0)
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(dataBuf), decipher.final()])
}

export function xor32hex(a, b) {
    const x = (parseInt(a, 16) ^ parseInt(b, 16)) >>> 0
    return x.toString(16).padStart(8, "0")
}

export function b64urlToBuffer(b64url) {
    let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    return Buffer.from(b64, "base64")
}
