/// Pure playback synchronization state machine.
/// The host is authoritative; guests derive their expected position from
/// the last broadcast state plus elapsed server time.
module SyncEngine.SyncEngine

type PlaybackState =
    { Playing: bool
      /// Video position (seconds) at the moment the state was captured.
      CurrentTime: float
      Speed: float
      /// Server epoch ms when the state was captured.
      UpdatedAt: float }

type SyncEvent =
    | Play of timestamp: float * serverTime: float
    | Pause of timestamp: float * serverTime: float
    | Seek of targetTimestamp: float * serverTime: float
    | SpeedChange of speed: float * serverTime: float

let initialState: PlaybackState =
    { Playing = false; CurrentTime = 0.0; Speed = 1.0; UpdatedAt = 0.0 }

/// Where playback should be right now, given the current server clock.
let computeExpectedTime (state: PlaybackState) (serverNow: float) : float =
    if state.Playing then
        state.CurrentTime + max 0.0 (serverNow - state.UpdatedAt) / 1000.0 * state.Speed
    else
        state.CurrentTime

let applyEvent (state: PlaybackState) (evt: SyncEvent) : PlaybackState =
    match evt with
    | Play(ts, server) -> { state with Playing = true; CurrentTime = ts; UpdatedAt = server }
    | Pause(ts, server) -> { state with Playing = false; CurrentTime = ts; UpdatedAt = server }
    | Seek(target, server) -> { state with CurrentTime = target; UpdatedAt = server }
    | SpeedChange(speed, server) ->
        // Re-anchor so position stays continuous across the speed change.
        { state with CurrentTime = computeExpectedTime state server; Speed = speed; UpdatedAt = server }

let driftSeconds (expected: float) (actual: float) : float = abs (expected - actual)

/// Silent re-seek threshold (SP-06).
let needsCorrection (expected: float) (actual: float) : bool =
    driftSeconds expected actual > 1.5

/// "Catching up…" pause threshold (SP-07).
let needsCatchUpPause (expected: float) (actual: float) : bool =
    driftSeconds expected actual > 3.0

/// A catching-up guest may resume once within this margin.
let caughtUp (expected: float) (actual: float) : bool =
    driftSeconds expected actual < 0.5
