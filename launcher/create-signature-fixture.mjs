import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Output directory argument is required.");
fs.mkdirSync(outputDirectory, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const publicDer = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
const keyId = `p256-${crypto.createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`;
const stable = {
  schemaVersion: 1,
  productId: "fallout-maw",
  channel: "compatibility-test",
  sequence: 1,
  publishedAt: new Date(0).toISOString(),
  signature: {
    algorithm: "ECDSA_P256_SHA256",
    keyId,
    url: "stable.json.sig"
  },
  system: {
    version: "1.0.0",
    minimumLauncherVersion: "1.0.0",
    full: { url: "full.zip", size: 1, sha256: "0".repeat(64) },
    patches: []
  }
};
const bytes = Buffer.from(`${JSON.stringify(stable, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(outputDirectory, "stable.json"), bytes);
fs.writeFileSync(path.join(outputDirectory, "stable.json.sig"), crypto.sign("sha256", bytes, privateKey));
fs.writeFileSync(path.join(outputDirectory, "public-key.pem"), publicKey, "utf8");
