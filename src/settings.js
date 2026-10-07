import fs from 'node:fs';
import path from 'node:path';

export const defaults = () => ({
  enabled: false, muteSeconds: 300, silenceSeconds: 600,
  muteTarget: null, silenceTarget: null, watchChannel: null,
  exemptUsers: {}, exemptRoles: {}, managedMutes: {}, ignoredChannels: [], logChannel: null,
});

export class Settings {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'settings.json');
    // A corrupt config must never silently erase existing exemptions.
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  get(id) { return { ...defaults(), ...this.data[id] }; }
  update(id, patch) {
    const next = { ...this.data, [id]: { ...this.get(id), ...patch } };
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.data = next;
    return this.get(id);
  }
}
