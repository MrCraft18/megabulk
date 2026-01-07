import { Buffer } from "node:buffer"
import crypto from "node:crypto"

import b64urlToBuffer from "../../../common/b64urlToBuffer.js"

export default function decryptNodeAttributes(node, folderKey) {
    function aes128EcbDecrypt(keyHex, dataBuf) {
        const key = Buffer.from(keyHex, "hex")
        const decipher = crypto.createDecipheriv("aes-128-ecb", key, null)
        decipher.setAutoPadding(false)
        return Buffer.concat([decipher.update(dataBuf), decipher.final()])
    }

    function aes128CbcDecrypt(keyHex, dataBuf) {
        const key = Buffer.from(keyHex, "hex")
        const iv = Buffer.alloc(16, 0)
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv)
        decipher.setAutoPadding(false)
        return Buffer.concat([decipher.update(dataBuf), decipher.final()])
    }

    function xor32hex(a, b) {
        const x = (parseInt(a, 16) ^ parseInt(b, 16)) >>> 0
        return x.toString(16).padStart(8, "0")
    }

    const nodeKeyB64 = node.k.split(':').at(-1)
    const nodeKeyBytes = b64urlToBuffer(nodeKeyB64)
    const nodeKeyHex = aes128EcbDecrypt(folderKey, nodeKeyBytes).toString("hex")

    let attrKeyHex
    if (nodeKeyHex.length === 32) {
        attrKeyHex = nodeKeyHex
    } else {
        if (nodeKeyHex.length < 64) return null
        const w = []
        for (let i = 0; i < 8; i++) w.push(nodeKeyHex.slice(i * 8, i * 8 + 8))
        attrKeyHex = xor32hex(w[0], w[4]) + xor32hex(w[1], w[5]) + xor32hex(w[2], w[6]) + xor32hex(w[3], w[7])
    }

    if (attrKeyHex.length !== 32) return null

    const attrCipher = b64urlToBuffer(node.a)
    const attrPlain = aes128CbcDecrypt(attrKeyHex, attrCipher)

    const attributes = attrPlain.toString("utf8").replace(/\0+$/g, "").replace(/^MEGA/, "")

    return attributes
}
