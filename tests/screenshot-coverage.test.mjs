import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dictionary = JSON.parse(readFileSync(
  new URL('../claude-tw/overrides.json', import.meta.url), 'utf8',
));

// Regression for exact strings observed in screenshots only.
// Dictionary entries do not prove renderer matching or real DOM coverage.
const observedStrings = [
  'Scheduled tasks',
  'Run tasks on a schedule or whenever you need them. Type',
  'in any existing task to set one up.',
  'Sort by',
  'Next run',
  'Daily briefing',
  'What needs your attention today across calendar, email, and messages.',
  'Weekdays at 8:00 AM',
  'Inbox triage',
  'Categorize your inbox and draft replies to anything urgent.',
  'Chats and tasks',
  'Artifacts',
  'New slides and Design projects are created as artifacts.',
  'New Slides and Design projects are created as artifacts.',
  'Visit the standalone homepage',
  'Make something new',
  'Document',
  'Presentation',
  'Beta',
  'Search scheduled tasks',
  'Scheduled tasks only run while your computer is awake and online.',
  'Keep awake',
  'No scheduled tasks yet.',
  'Meeting prep',
  'A short brief before each meeting on your calendar, covering attendees, context, and agenda.',
  'Weekly review',
  'A Friday summary of what happened this week.',
  'Every Friday at 4:00 PM',
  'Content ideas',
  'Draft a few post ideas each week from the latest news in your industry.',
  'Every Monday at 9:00 AM',
  'Monitor a topic',
  'Watch for news or mentions of a topic, competitor, or keyword.',
  'Daily at 9:00 AM',
];

for (const source of observedStrings) {
  test(`observed screenshot dictionary entry translates: ${source}`, () => {
    assert.ok(Object.hasOwn(dictionary, source), `Missing exact key: ${source}`);
    const translated = dictionary[source];
    assert.equal(typeof translated, 'string', `Translation must be a string: ${source}`);
    assert.ok(translated.trim().length > 0, `Translation must not be empty: ${source}`);
    assert.notEqual(translated.trim(), source, `Translation must not be identity: ${source}`);
  });
}

for (const preserved of ['/schedule', 'Claude Design']) {
  test(`command or brand remains absent or unchanged: ${preserved}`, () => {
    if (Object.hasOwn(dictionary, preserved)) {
      assert.equal(dictionary[preserved], preserved, `Do not translate command or brand: ${preserved}`);
    }
  });
}
