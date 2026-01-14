import MegabulkProcess from "./classes/MegabulkProcess/index.js"
import { verifyFileCbcMac } from "./classes/File/index.js"

const [,, mode, arg1, arg2, arg3, arg4] = process.argv

if (mode === "--verify") {
    if (!arg1 || !arg2 || !arg3 || !arg4) {
        console.error("Usage: node index.js --verify <file-path> <key-hex> <nonce-hex> <meta-mac-hex>")
        process.exit(1)
    }

    const onProgress = process.send
        ? (processed, total) => {
            process.send({ type: "verify-progress", processed, total })
        }
        : null

    const ok = await verifyFileCbcMac(arg1, arg2, arg3, arg4, onProgress)
    process.exit(ok ? 0 : 2)
}

const link = mode
const downloadDirectory = arg1

if (!link || !downloadDirectory) {
    console.error("Usage: node index.js <mega-folder-link> <download-path>")
    process.exit(1)
}

const main = new MegabulkProcess({ folderLink: link, downloadDirectory })

await main.start()
