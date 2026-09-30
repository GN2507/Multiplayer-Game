import { getStore } from "@netlify/blobs";

export const handler = async (event: any) => {
  const store = getStore("game-rooms");
  const path = event.path.replace("/.netlify/functions/game", "");
  const method = event.httpMethod;

  try {
    const body = event.body ? JSON.parse(event.body) : {};

    // POST /create - Create Room
    if (method === "POST" && path === "/create") {
      const code = Math.random().toString(36).substring(2, 6).toUpperCase();
      const playerId = Math.random().toString(36).substring(2, 9);
      const room = {
        code,
        hostId: playerId,
        players: [{ id: playerId, name: body.name, score: 0 }],
        state: "LOBBY",
        round: 0,
        maxRounds: 3,
        submissions: {},
        votes: {}
      };
      await store.setJSON(code, room);
      return {
        statusCode: 200,
        body: JSON.stringify({ roomCode: code, playerId })
      };
    }

    // POST /join - Join Room
    if (method === "POST" && path === "/join") {
      const code = body.roomCode.toUpperCase();
      const room: any = await store.get(code, { type: "json" });
      if (!room) return { statusCode: 404, body: JSON.stringify({ error: "Room not found" }) };

      const playerId = Math.random().toString(36).substring(2, 9);
      room.players.push({ id: playerId, name: body.name, score: 0 });
      await store.setJSON(code, room);

      return {
        statusCode: 200,
        body: JSON.stringify({ roomCode: code, playerId })
      };
    }

    // GET /state?code=ABCD - Fetch Room State (polling)
    if (method === "GET" && path === "/state") {
      const code = event.queryStringParameters.code;
      const room = await store.get(code, { type: "json" });
      if (!room) return { statusCode: 404, body: JSON.stringify({ error: "Room not found" }) };
      return { statusCode: 200, body: JSON.stringify(room) };
    }

    return { statusCode: 400, body: "Invalid Route" };
  } catch (err: any) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};