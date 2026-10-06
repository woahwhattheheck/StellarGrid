// Shared Boggle-style board generator used by both the daily puzzle route
// (app/api/generate-board/route.ts, seeded by date) and staked match creation
// (lib/match-actions.ts, seeded randomly per match).

const BOGGLE_DICE = [
  ["R", "I", "F", "O", "B", "X"],
  ["I", "F", "E", "H", "E", "Y"],
  ["D", "E", "N", "O", "W", "S"],
  ["U", "T", "O", "K", "N", "D"],
  ["H", "M", "S", "R", "A", "O"],
  ["L", "U", "P", "E", "T", "S"],
  ["A", "C", "I", "T", "O", "A"],
  ["Y", "L", "G", "K", "U", "E"],
  ["Q", "B", "M", "J", "O", "A"],
  ["E", "H", "I", "S", "P", "N"],
  ["V", "E", "T", "I", "G", "N"],
  ["B", "A", "L", "I", "Y", "T"],
  ["E", "Z", "A", "V", "N", "D"],
  ["R", "A", "L", "E", "S", "C"],
  ["U", "W", "I", "L", "R", "G"],
  ["P", "A", "C", "E", "M", "D"],
]

export interface LengthRequirements {
  [length: number]: number
}

export const DEFAULT_LENGTH_REQUIREMENTS: LengthRequirements = {
  6: 5, // At least 5 six-letter words
  7: 5, // At least 5 seven-letter words
  8: 5, // At least 5 eight-letter words
}

export interface GeneratedBoard {
  board: string[][]
  wordCount: number
  attempts: number
  allWords: string[]
  distribution: { [length: number]: number }
}

class TrieNode {
  children: Map<string, TrieNode>
  isEndOfWord: boolean

  constructor() {
    this.children = new Map()
    this.isEndOfWord = false
  }

  addWord(word: string) {
    insertIntoTrie(this, word.toUpperCase())
  }
}

function insertIntoTrie(root: TrieNode, word: string) {
  let current = root
  for (const char of word) {
    if (!current.children.has(char)) {
      current.children.set(char, new TrieNode())
    }
    current = current.children.get(char)!
  }
  current.isEndOfWord = true
}

class BoardSolver {
  board: string[][]
  trie: TrieNode
  answers: Set<string>

  constructor(board: string[][], trie: TrieNode) {
    this.board = board
    this.trie = trie
    this.answers = new Set()
  }

  findAllWords() {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        this.dfs(i, j, "", new Set(), this.trie)
      }
    }
  }

  dfs(row: number, col: number, word: string, visited: Set<string>, trieNode: TrieNode) {
    if (row < 0 || row >= 4 || col < 0 || col >= 4) return

    const key = `${row},${col}`
    if (visited.has(key)) return

    const char = this.board[row][col]
    if (!trieNode.children.has(char)) return

    const newWord = word + char
    const newTrieNode = trieNode.children.get(char)!
    const newVisited = new Set(visited)
    newVisited.add(key)

    if (newTrieNode.isEndOfWord && newWord.length >= 3) {
      this.answers.add(newWord)
    }

    const directions = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1], [0, 1],
      [1, -1], [1, 0], [1, 1],
    ]

    for (const [dr, dc] of directions) {
      this.dfs(row + dr, col + dc, newWord, newVisited, newTrieNode)
    }
  }
}

/**
 * Re-validates candidate words against an already-persisted board using the
 * same trie/DFS path rules as board generation. The candidate list can be
 * prefiltered by the caller's dictionary/rule policy.
 */
export function findWordsOnBoard(board: string[][], words: string[]): Set<string> {
  if (board.length !== 4 || board.some((row) => row.length !== 4)) {
    return new Set()
  }

  const trie = new TrieNode()
  const normalizedWords = new Set(
    words
      .map((word) => word.trim().toUpperCase())
      .filter((word) => word.length >= 3),
  )
  normalizedWords.forEach((word) => trie.addWord(word))

  const normalizedBoard = board.map((row) => row.map((letter) => letter.toUpperCase()))
  const solver = new BoardSolver(normalizedBoard, trie)
  solver.findAllWords()
  return new Set(solver.answers)
}

// Stateful Linear Congruential Generator for deterministic seeded random
class SeededRandom {
  private seed: number

  constructor(seed: number) {
    this.seed = seed % 2147483647
    if (this.seed <= 0) this.seed += 2147483646
  }

  next(): number {
    this.seed = (this.seed * 16807) % 2147483647
    return (this.seed - 1) / 2147483646
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max)
  }
}

function shuffleArray<T>(array: T[], seed: number): T[] {
  const shuffled = [...array]
  const rng = new SeededRandom(seed)

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export function checkLengthRequirements(words: string[], requirements: LengthRequirements): boolean {
  const lengthCounts: { [length: number]: number } = {}

  words.forEach((word) => {
    const len = word.length
    lengthCounts[len] = (lengthCounts[len] || 0) + 1
  })

  for (const [length, required] of Object.entries(requirements)) {
    const lengthNum = parseInt(length)
    const count = lengthCounts[lengthNum] || 0
    if (count < required) {
      return false
    }
  }

  return true
}

export function getWordDistribution(words: string[]): { [length: number]: number } {
  const distribution: { [length: number]: number } = {}

  words.forEach((word) => {
    const len = word.length
    distribution[len] = (distribution[len] || 0) + 1
  })

  return distribution
}

/**
 * Hashes an arbitrary string (e.g. a date) into a stable positive seed.
 * Used for the deterministic daily board; random matches use generateRandomSeed() instead.
 */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5 // FNV offset basis

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0 // FNV prime, unsigned 32-bit
  }

  hash = ((hash >>> 16) ^ hash) * 0x85ebca6b
  hash = ((hash >>> 13) ^ hash) * 0xc2b2ae35
  hash = (hash >>> 16) ^ hash

  return Math.abs(hash) + 1 // Ensure positive and non-zero
}

/** Generates a fresh random seed for a one-off (non-deterministic) board, e.g. a staked match. */
export function generateRandomSeed(): number {
  return Math.floor(Math.random() * 2147483646) + 1
}

function generateBoardFromDice(seedVariant: number): string[][] {
  const shuffledDice = shuffleArray(BOGGLE_DICE, seedVariant)
  const board: string[][] = Array(4)
    .fill(null)
    .map(() => Array(4).fill(""))

  const rng = new SeededRandom(seedVariant + 1000)
  for (let i = 0; i < 16; i++) {
    const die = shuffledDice[i]
    const faceIndex = rng.nextInt(6)
    const letter = die[faceIndex]

    const row = Math.floor(i / 4)
    const col = i % 4
    board[row][col] = letter
  }

  return board
}

/**
 * Generates a board deterministically from a numeric seed, retrying variants
 * of the seed until the minimum word count / length requirements are met
 * (or falling back to the best board found after maxAttempts).
 */
export function generateBoardFromSeed(
  baseSeed: number,
  words3: string[],
  minWords: number = 50,
  lengthRequirements: LengthRequirements = DEFAULT_LENGTH_REQUIREMENTS,
): GeneratedBoard {
  let attempts = 0
  const maxAttempts = 200

  const trie = new TrieNode()
  words3.forEach((word) => trie.addWord(word))

  let bestBoard: string[][] | null = null
  let bestWords: string[] = []
  let bestDistribution: { [length: number]: number } = {}
  let bestScore = 0

  while (attempts < maxAttempts) {
    attempts++
    const seedVariant = baseSeed + attempts
    const board = generateBoardFromDice(seedVariant)

    const solver = new BoardSolver(board, trie)
    solver.findAllWords()
    const wordCount = solver.answers.size
    const allWords = Array.from(solver.answers).sort()
    const distribution = getWordDistribution(allWords)

    let score = wordCount
    if (checkLengthRequirements(allWords, lengthRequirements)) {
      score += 1000
    } else {
      for (const [length, required] of Object.entries(lengthRequirements)) {
        const lengthNum = parseInt(length)
        const count = distribution[lengthNum] || 0
        score += Math.min(count, required) * 10
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestBoard = board
      bestWords = allWords
      bestDistribution = distribution
    }

    if (wordCount >= minWords && checkLengthRequirements(allWords, lengthRequirements)) {
      return { board, wordCount, attempts, allWords, distribution }
    }
  }

  if (bestBoard) {
    return {
      board: bestBoard,
      wordCount: bestWords.length,
      attempts: maxAttempts,
      allWords: bestWords,
      distribution: bestDistribution,
    }
  }

  // Ultimate fallback: first dice arrangement for this seed, whatever it solves to.
  const fallbackBoard = generateBoardFromDice(baseSeed)
  const solver = new BoardSolver(fallbackBoard, trie)
  solver.findAllWords()
  const fallbackWords = Array.from(solver.answers).sort()

  return {
    board: fallbackBoard,
    wordCount: solver.answers.size,
    attempts: maxAttempts,
    allWords: fallbackWords,
    distribution: getWordDistribution(fallbackWords),
  }
}

/** Convenience wrapper for the deterministic daily puzzle, seeded by date string. */
export function generateBoardForDate(
  dateString: string,
  words3: string[],
  minWords: number = 50,
  lengthRequirements: LengthRequirements = DEFAULT_LENGTH_REQUIREMENTS,
): GeneratedBoard {
  return generateBoardFromSeed(hashSeed(dateString), words3, minWords, lengthRequirements)
}
