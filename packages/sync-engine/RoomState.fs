/// Room membership model shared by host and guest UIs.
module SyncEngine.RoomState

type User =
    { Id: string
      Name: string
      Color: string
      IsHost: bool }

type RoomState =
    { Users: User list }

let empty: RoomState = { Users = [] }

let addUser (room: RoomState) (user: User) : RoomState =
    if room.Users |> List.exists (fun u -> u.Id = user.Id) then room
    else { room with Users = room.Users @ [ user ] }

let removeUser (room: RoomState) (userId: string) : RoomState =
    { room with Users = room.Users |> List.filter (fun u -> u.Id <> userId) }

let guestCount (room: RoomState) : int =
    room.Users |> List.filter (fun u -> not u.IsHost) |> List.length
