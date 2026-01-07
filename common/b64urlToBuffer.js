import { Buffer } from "node:buffer"

export default function b64urlToBuffer(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/")
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : ""
    return Buffer.from(b64 + pad, "base64")
}
