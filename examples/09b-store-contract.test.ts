// The tests every Store must pass, run against a store of your own (node:test:
// run this file with `node --test`). The store here keeps each entry as JSON
// text, as a store with a text column would.

import { memoryStore, entryToJSON, entryFromJSON, type Entry, type Store } from 'fix.js';
import { storeContract } from 'fix.js/test';

interface TextStore extends Store {
  close(): Promise<void>;
}

function textStore(): TextStore {
  const rows = memoryStore();
  const toText = (entry: Entry) => JSON.stringify(entryToJSON(entry));
  const fromText = (text: string) => entryFromJSON(JSON.parse(text)) as Entry;
  return {
    ...rows,
    append: (id, records, context) =>
      rows.append(id, records.map(record => (record.entry ? { ...record, entry: fromText(toText(record.entry)) } : record)), context),
    close: async () => {},              // a real store closes its file or its connection here
  };
}

storeContract('textStore', () => textStore(), { cleanup: store => store.close() });
