import assert from 'node:assert';
import { PDFDocument } from 'pdf-lib';
import { extractImagesFromPdf } from '../dist/tools/pdf/extract-images.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

async function main() {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  const bytes = await document.save();

  const startedAt = Date.now();
  const result = await extractImagesFromPdf(bytes);
  const elapsedMs = Date.now() - startedAt;

  assert.deepStrictEqual(result, { 1: [] });
  assert.ok(elapsedMs < 10_000, `PDF extraction/cleanup took ${elapsedMs}ms`);
  console.log(`✓ PDF proxy cleanup completed in ${elapsedMs}ms`);
}

main().catch(error => {
  console.error('✗ PDF image lifecycle failed:', error.stack || error.message);
  process.exit(1);
});
