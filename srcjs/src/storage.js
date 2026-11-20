// Browser storage keys. Plank was called pqview before 0.14.0; its saved
// preferences, marks and views (keys "pqview.*") are copied once to the new
// "plank.*" keys, so readers keep them. The old keys are left in place.

export const PREFIX = 'plank.'
const OLD_PREFIX = 'pqview.'
const DONE = PREFIX + 'migrated'

/**
 * Copy every "pqview.x" key to "plank.x" (unless that is already set), once.
 * @param {Storage} storage localStorage, or anything with its methods
 * @returns {number} how many keys were copied
 */
export function migrateKeys(storage) {
  try {
    if (!storage || storage.getItem(DONE)) return 0
    const keys = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k && k.startsWith(OLD_PREFIX)) keys.push(k)
    }
    let n = 0
    for (const k of keys) {
      const to = PREFIX + k.slice(OLD_PREFIX.length)
      if (storage.getItem(to) === null) {
        storage.setItem(to, storage.getItem(k))
        n++
      }
    }
    storage.setItem(DONE, '1')
    return n
  } catch {
    return 0
  }
}
