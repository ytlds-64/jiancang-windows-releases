import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { NtExecutable, NtExecutableResource } from 'pe-library';
import { Data, Resource } from 'resedit';

const [sourcePath, iconPath, destinationPath] = process.argv.slice(2);
const original = NtExecutable.from(readFileSync(sourcePath), { ignoreCert: true });
const resources = NtExecutableResource.from(original);
const icons = Data.IconFile.from(readFileSync(iconPath));
const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
assert.ok(groups.length > 0, 'The verified Electron executable has no Windows icon group.');

const iconResourceTypes = new Set([3, 14]);
const resourceKey = entry => JSON.stringify([entry.type, entry.id, entry.lang, entry.codepage]);
const otherResources = entries => entries
  .filter(entry => !iconResourceTypes.has(entry.type))
  .map(entry => [
    resourceKey(entry),
    Buffer.from(entry.bin),
  ]).sort((a, b) => a[0].localeCompare(b[0]));
const originalOtherResources = otherResources(resources.entries);
const originalSections = original.getAllSections()
  .filter(section => section.info.name !== '.rsrc')
  .map(section => [section.info.name, Buffer.from(section.data || new ArrayBuffer(0))]);

const displayNames = { FileDescription: '见藏', ProductName: '见藏' };
const originalVersionNames = new Map();
for (const entry of resources.entries.filter(entry => entry.type === 16)) {
  const [version] = Resource.VersionInfo.fromEntries([entry]);
  const languages = version.getAllLanguagesForStringValues();
  assert.ok(languages.length > 0, 'The Electron version resource must have a string table.');
  originalVersionNames.set(resourceKey(entry), languages.map(language => ({
    language,
    values: Object.fromEntries(Object.keys(displayNames).map(key => [key, version.getStringValues(language)[key]])),
  })));
  for (const language of languages) version.setStringValues(language, displayNames, false);
  // Keep the existing resource ID, language and codepage (the Electron entry
  // uses codepage 0, while generateResource defaults that header to 1200).
  entry.bin = version.generateResource().bin;
}
assert.ok(originalVersionNames.size > 0, 'The verified Electron executable has no version resource.');

for (const group of groups) {
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries, group.id, group.lang, icons.icons.map(entry => entry.data),
  );
}
resources.outputResource(original);
const branded = Buffer.from(original.generate());

const verified = NtExecutable.from(branded);
const verifiedResources = NtExecutableResource.from(verified);
const verifiedGroups = Resource.IconGroupEntry.fromEntries(verifiedResources.entries);
assert.deepEqual(
  verifiedGroups.map(group => [group.id, group.lang]),
  groups.map(group => [group.id, group.lang]),
  'The branded executable must preserve the Electron icon group IDs and languages.',
);
const icoFrames = icons.icons.map(frame => Buffer.from(frame.data.bin));
for (const group of verifiedGroups) {
  const members = group.getIconItemsFromEntries(verifiedResources.entries);
  assert.deepEqual(members.map(member => Buffer.from(member.bin)), icoFrames,
    'Every icon group must contain the expected 见藏 frames.');
}
const restoredDisplayNames = verifiedResources.entries.map(entry => {
  if (entry.type !== 16) return entry;
  const tables = originalVersionNames.get(resourceKey(entry));
  assert.ok(tables, 'The branded executable must preserve each version resource identity.');
  const [version] = Resource.VersionInfo.fromEntries([entry]);
  assert.deepEqual(version.getAllLanguagesForStringValues(), tables.map(table => table.language));
  for (const { language, values } of tables) {
    for (const [key, expected] of Object.entries(displayNames)) {
      assert.equal(version.getStringValues(language)[key], expected,
        `The Windows ${key} must display 见藏.`);
      if (values[key] === undefined) version.removeStringValue(language, key, false);
      else version.setStringValue(language, key, values[key], false);
    }
  }
  return { ...entry, bin: version.generateResource().bin };
});
assert.deepEqual(otherResources(restoredDisplayNames), originalOtherResources,
  'The executable must preserve all resources except its icons and the two approved display-name strings.');
assert.deepEqual(
  verified.getAllSections().filter(section => section.info.name !== '.rsrc')
    .map(section => [section.info.name, Buffer.from(section.data || new ArrayBuffer(0))]),
  originalSections,
  'The executable must preserve all code and non-resource section data.',
);
writeFileSync(destinationPath, branded);
