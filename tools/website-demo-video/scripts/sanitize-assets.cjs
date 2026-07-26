const path = require("node:path");
const Jimp = require("jimp");

const repoRoot = path.resolve(__dirname, "../../..");
const sourceRoot = path.join(repoRoot, "test-results");
const outputRoot = path.join(__dirname, "../public/screenshots");

const assets = [
  {
    input: path.join(sourceRoot, "caogen-deep/2026-07-25T21-40-08-025Z/02-provider-editor-filled.png"),
    output: path.join(outputRoot, "provider-settings.png"),
    redactions: [
      // Hide the synthetic backup-key field before the screenshot enters a public asset.
      { x: 0.27, y: 0.36, width: 0.25, height: 0.065 },
    ],
  },
];

const redact = (image, box) => {
  const x = Math.round(image.bitmap.width * box.x);
  const y = Math.round(image.bitmap.height * box.y);
  const width = Math.round(image.bitmap.width * box.width);
  const height = Math.round(image.bitmap.height * box.height);
  image.scan(x, y, width, height, (_x, _y, idx) => {
    image.bitmap.data[idx] = 14;
    image.bitmap.data[idx + 1] = 16;
    image.bitmap.data[idx + 2] = 20;
    image.bitmap.data[idx + 3] = 255;
  });
};

const main = async () => {
  for (const asset of assets) {
    const image = await Jimp.read(asset.input);
    for (const box of asset.redactions) redact(image, box);
    await image.writeAsync(asset.output);
    console.log(`${path.basename(asset.output)} ${image.bitmap.width}x${image.bitmap.height}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
