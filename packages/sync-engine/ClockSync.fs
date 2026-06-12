/// NTP-style clock offset estimation between a client and the sync server.
/// All timestamps are epoch milliseconds as floats (JS number-safe).
module SyncEngine.ClockSync

type ClockSample =
    { ClientSend: float
      ServerTime: float
      ClientReceive: float }

/// Offset for a single ping/response exchange, assuming symmetric latency.
let sampleOffset (s: ClockSample) : float =
    let rtt = s.ClientReceive - s.ClientSend
    s.ServerTime - (s.ClientSend + rtt / 2.0)

let sampleRtt (s: ClockSample) : float = s.ClientReceive - s.ClientSend

/// Median offset across samples — robust against a single delayed exchange.
let computeOffset (samples: ClockSample list) : float =
    match samples with
    | [] -> 0.0
    | _ ->
        let sorted = samples |> List.map sampleOffset |> List.sort
        let n = List.length sorted
        if n % 2 = 1 then
            List.item (n / 2) sorted
        else
            (List.item (n / 2 - 1) sorted + List.item (n / 2) sorted) / 2.0
