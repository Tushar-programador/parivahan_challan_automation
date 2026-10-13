// Starts every search (the caller's limiter caps how many run at once) and reports each result by
// its position as soon as it finishes. `write` returning false means the client left, so stop reporting.
async function runBatch(applicationNos, search, write) {
  let stopped = false;
  await Promise.all(applicationNos.map(async (applicationNo, index) => {
    let result;
    try {
      result = await search(applicationNo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { status: 'WEBSITE_ERROR', applicationNo: String(applicationNo).trim(), message: `Unexpected server error: ${message}` };
    }
    if (stopped) return;
    if (write({ index, result }) === false) stopped = true;
  }));
}

module.exports = { runBatch };
