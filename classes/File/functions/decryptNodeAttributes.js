import { aes128EcbDecrypt, aes128CbcDecrypt, xor32hex, b64urlToBuffer } from "../../../common/megaCrypto.js"

export default function decryptNodeAttributes(node, folderKey) {

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
