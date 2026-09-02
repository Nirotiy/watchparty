import fs from "node:fs";

const adjectives = fs
  .readFileSync(process.cwd() + "/words/adjectives.txt")
  .toString()
  .split(/\r?\n/)
  .filter(Boolean);
const nouns = fs
  .readFileSync(process.cwd() + "/words/nouns.txt")
  .toString()
  .split(/\r?\n/)
  .filter(Boolean);
const verbs = fs
  .readFileSync(process.cwd() + "/words/verbs.txt")
  .toString()
  .split(/\r?\n/)
  .filter(Boolean);

const randomElement = (array: string[]) =>
  array[Math.floor(Math.random() * array.length)];

export function makeRoomName(): string {
  return `${randomElement(adjectives)}-${randomElement(nouns)}-${randomElement(verbs)}`;
}

export function makeUserName(): string {
  return `${capFirst(randomElement(adjectives))} ${capFirst(randomElement(nouns))}`;
}

function capFirst(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
