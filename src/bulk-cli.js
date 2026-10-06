#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  parseApplicationNumbers,
  processBulk,
  createCsv,
  createXlsx
} = require('./bulk');

function printUsage() {
  console.log('Usage: node src/bulk-cli.js <input.csv> [--format csv|xlsx|json] [--output <path>]');
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((arg) => !arg.startsWith('--'));
  const formatIndex = args.indexOf('--format');
  const outputIndex = args.indexOf('--output');
  const format = formatIndex >= 0 ? args[formatIndex + 1] : 'csv';
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;

  if (!inputPath || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(inputPath ? 0 : 1);
  }
  if (!['csv', 'xlsx', 'json'].includes(format)) {
    throw new Error('Format must be csv, xlsx, or json.');
  }
  if (format !== 'json' && !outputPath) {
    throw new Error('Specify --output when exporting to CSV or XLSX.');
  }

  const csvText = await fs.readFile(inputPath, 'utf8');
  const applicationNumbers = parseApplicationNumbers(csvText);
  const results = await processBulk(applicationNumbers);

  if (format === 'json') {
    const target = outputPath || path.join(
      path.dirname(inputPath),
      `${path.basename(inputPath, path.extname(inputPath))}-results.json`
    );
    await fs.writeFile(target, `${JSON.stringify({ results }, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${results.length} results to ${target}`);
    return;
  }

  const target = outputPath;
  const contents = format === 'csv' ? createCsv(results) : await createXlsx(results);
  await fs.writeFile(target, contents);
  console.log(`Wrote ${results.length} results to ${target}`);
}

main().catch((error) => {
  console.error(`Bulk search failed: ${error.message}`);
  process.exit(1);
});
