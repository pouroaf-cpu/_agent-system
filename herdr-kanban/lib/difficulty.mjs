export const DIFFICULTIES = ['tiny', 'easy', 'medium', 'hard']
export function difficultyFromText(text) {
  return text.match(/^\*\*Difficulty:\*\*[ \t]*(tiny|easy|medium|hard)[ \t]*\r?$/im)?.[1]?.toLowerCase()
    || (/^\*\*Trivial:\*\*[ \t]*yes[ \t]*\r?$/im.test(text) ? 'easy' : null)
}
export function builderDifficulty(card, state = {}) {
  return DIFFICULTIES[Math.max(DIFFICULTIES.indexOf(card?.difficulty || (card?.trivial ? 'easy' : 'medium')), DIFFICULTIES.indexOf(state.builderDifficulty))]
}
