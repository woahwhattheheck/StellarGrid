"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { LetterGrid } from "./letter-grid"
import { FoundWordsList } from "./found-words-list"
import { MatchScoreboard } from "./match-scoreboard"
import { StakeConfirmation } from "./stake-confirmation"
import { MatchResults } from "./match-results"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { useMatchStore } from "@/stores/matchStore"

interface StakedMatchGameProps {
  matchId: string
}

// Staked-match counterpart to components/word-grid-game.tsx: same grid/input
// primitives, but state is sourced from stores/matchStore.ts (per-match)
// instead of stores/gameStore.ts (the daily single-player puzzle, which this
// component never touches).
export function StakedMatchGame({ matchId }: StakedMatchGameProps) {
  const { user } = useAuth()
  const router = useRouter()
  const {
    status,
    board,
    possibleWords,
    totalPossibleWords,
    foundWords,
    score,
    opponent,
    stakeAmount,
    assetCode,
    myStaked,
    winnerUserId,
    payoutTxHash,
    endsAt,
    loading,
    loadMatch,
    confirmMyStake,
    addFoundWord,
    submitFinalScore,
    subscribeToMatch,
    reset,
  } = useMatchStore()

  const [selectedPath, setSelectedPath] = useState<Array<{ row: number; col: number }>>([])
  const [wordValidationStatus, setWordValidationStatus] = useState<"valid" | "invalid" | "duplicate" | null>(null)

  useEffect(() => {
    if (!user) return
    loadMatch(matchId, user.id)
    const unsubscribe = subscribeToMatch(matchId, user.id)
    return () => {
      unsubscribe()
      reset()
    }
  }, [matchId, user, loadMatch, subscribeToMatch, reset])

  useEffect(() => {
    if (status !== "active" || !endsAt || !user) return
    const msLeft = new Date(endsAt).getTime() - Date.now()
    if (msLeft <= 0) {
      submitFinalScore(user.id)
      return
    }
    const timeout = setTimeout(() => submitFinalScore(user.id), msLeft)
    return () => clearTimeout(timeout)
  }, [status, endsAt, user, submitFinalScore])

  const possibleWordsSet = useMemo(() => new Set(possibleWords.map((w) => w.toUpperCase())), [possibleWords])

  const handlePathChange = useCallback((path: Array<{ row: number; col: number }>) => {
    setSelectedPath(path)
    if (path.length === 1) setWordValidationStatus(null)
  }, [])

  const handleWordComplete = useCallback(
    (word: string) => {
      const upperWord = word.toUpperCase()
      if (word.length < 4 || foundWords.includes(upperWord) || !possibleWordsSet.has(upperWord)) {
        setWordValidationStatus(foundWords.includes(upperWord) ? "duplicate" : "invalid")
      } else {
        setWordValidationStatus("valid")
        addFoundWord(upperWord, upperWord.length)
      }
      setTimeout(() => {
        setSelectedPath([])
        setWordValidationStatus(null)
      }, 800)
    },
    [foundWords, possibleWordsSet, addFoundWord],
  )

  if (!user) {
    return <p className="text-center py-10">Sign in to play staked matches.</p>
  }

  if (loading && !status) {
    return <p className="text-center py-10">Loading match…</p>
  }

  if (status === "created" || status === "awaiting_stakes") {
    const opponentPresent = status === "awaiting_stakes"
    return (
      <div className="space-y-4">
        {!opponentPresent && <p className="text-center text-muted-foreground">Waiting for an opponent to join…</p>}
        {opponentPresent && stakeAmount !== null && assetCode && (
          <StakeConfirmation
            stakeAmount={stakeAmount}
            assetCode={assetCode}
            myStaked={myStaked}
            opponentStaked={opponent?.staked ?? false}
            loading={loading}
            onConfirmStake={() => confirmMyStake(user.id)}
          />
        )}
      </div>
    )
  }

  if (status === "settled" || status === "refunded") {
    const didWin = status === "refunded" ? null : winnerUserId === user.id
    return (
      <MatchResults
        didWin={didWin}
        myScore={score}
        opponentScore={opponent?.score ?? 0}
        stakeAmount={stakeAmount ?? 0}
        assetCode={assetCode ?? "USDC"}
        payoutTxHash={payoutTxHash}
        onPlayAgain={() => router.push("/")}
      />
    )
  }

  return (
    <div className="space-y-3">
      <MatchScoreboard
        myScore={score}
        myWordsFound={foundWords.length}
        opponentScore={opponent?.score ?? 0}
        opponentConnected={opponent?.connectionStatus === "connected"}
        totalWords={totalPossibleWords}
      />

      <LetterGrid
        board={board}
        selectedPath={selectedPath}
        onPathChange={handlePathChange}
        onWordComplete={handleWordComplete}
        rotation={0}
        wordValidationStatus={wordValidationStatus}
      />

      <div className="flex justify-center">
        <Button variant="outline" onClick={() => user && submitFinalScore(user.id)} disabled={loading}>
          Submit &amp; End Match
        </Button>
      </div>

      <FoundWordsList words={foundWords} />
    </div>
  )
}
