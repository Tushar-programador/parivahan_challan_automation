#!/usr/bin/env node

const { searchTransaction, closeBrowser, normalizeApplicationNumber } = require('./automation');

async function main() {
  const input = process.argv[2];

  if (!input || process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node src/cli.js <application-no>');
    process.exit(0);
  }

  const applicationNo = normalizeApplicationNumber(input);
  const result = await searchTransaction(applicationNo);
  console.log(JSON.stringify(result, null, 2));
  await closeBrowser();
}

main().catch((error) => {
  console.error('Unexpected CLI error:', error);
  process.exit(1);
});
