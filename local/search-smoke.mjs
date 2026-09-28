const SEARCH_ID = /^search_\d+_\d+$/;
const START_LINE = /^Started (?:content|file) search session: (search_\d+_\d+)$/;

export function textOf(result) {
  return (result?.content ?? [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

export function extractSearchSessionId(result) {
  const structuredId = result?.structuredContent?.sessionId;
  if (typeof structuredId === 'string' && SEARCH_ID.test(structuredId)) {
    return structuredId;
  }

  const firstLine = textOf(result).split(/\r?\n/, 1)[0];
  const match = START_LINE.exec(firstLine);
  if (match) return match[1];

  throw new Error(`Unexpected start_search response; expected a search session ID on the first line. Received: ${firstLine || '<empty response>'}`);
}

function isComplete(text) {
  return /^Status:\s*COMPLETED\s*$/im.test(text);
}

/** Poll once even when the initial start_search response already has the marker. */
export async function pollSearchForMarker({
  sessionId,
  initialText,
  marker,
  callMore,
  deadlineMs,
  now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  intervalMs = 100,
}) {
  if (typeof sessionId !== 'string' || !SEARCH_ID.test(sessionId)) {
    throw new Error(`Invalid start_search session ID: ${String(sessionId)}`);
  }
  if (typeof callMore !== 'function') throw new TypeError('callMore must be a function');

  let latestText = initialText;
  let found = latestText.includes(marker);
  let polls = 0;
  let firstPoll = true;
  while (true) {
    if (!firstPoll && now() >= deadlineMs) {
      throw new Error(`Search deadline expired without finding ${marker}. Last response: ${latestText.slice(0, 1200)}`);
    }
    firstPoll = false;
    // The mandatory first poll validates the pagination tool even on the fast path.
    const remainingMs = Math.max(1, deadlineMs - now());
    latestText = await callMore(sessionId, remainingMs);
    polls++;
    found ||= latestText.includes(marker);
    if (found) return { text: latestText, found, polls };
    if (isComplete(latestText)) {
      throw new Error(`Search completed without finding ${marker}. Last response: ${latestText.slice(0, 1200)}`);
    }

    const remainingAfterCall = deadlineMs - now();
    if (remainingAfterCall <= 0) {
      throw new Error(`Search deadline expired without finding ${marker}. Last response: ${latestText.slice(0, 1200)}`);
    }
    await wait(Math.min(intervalMs, remainingAfterCall));
    if (now() >= deadlineMs) {
      throw new Error(`Search deadline expired without finding ${marker}. Last response: ${latestText.slice(0, 1200)}`);
    }
  }
}
