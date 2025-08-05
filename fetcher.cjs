const axios = require("axios");
const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config.json");
const mysql = require("mysql2/promise");
const pool = mysql.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.pw,
    database: config.db.db,
    connectionLimit: 5,
});

const MODES = {
    osu: 0,
    taiko: 1,
    fruits: 2,
    mania: 3,
};

let token;
let refresh = 0;
let user_ids = [];
let retries = {
    osu: {
        score: 0,
    },
    mania: {
        score: 0,
    },
    taiko: {
        score: 0,
    },
    fruits: {
        score: 0,
    },
};
let done = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshToken() {
    return new Promise((resolve, reject) => {
        axios({
            url: "https://osu.ppy.sh/oauth/token",
            method: "post",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            data: {
                grant_type: "client_credentials",
                client_id: config.osu.id,
                client_secret: config.osu.secret,
                scope: "public",
            },
        })
            .then((data) => {
                refresh = Date.now() + data.data.expires_in * 1000;
                resolve("Bearer " + data.data.access_token);
            })
            .catch((err) => {
                reject(err);
            });
    });
}

async function fullRankingsUpdate(mode, type, cursor_string, entries = 0) {
  if (Date.now() > refresh - 5 * 60 * 1000) {
    token = await refreshToken();
  }

  const osuAPI = axios.create({
    baseURL: "https://osu.ppy.sh/api/v2",
    headers: { Authorization: token },
    json: true,
  });

  try {
    const res = await osuAPI.get("/rankings/" + mode + "/" + type, {
      params: { cursor_string },
    });

    console.log("rankings/" + mode + "/" + type, { params: { cursor_string } });
    console.log("entries" + entries);

    const maxUserFetch = 1000;

    for (const elem of res.data.ranking) {
      if (entries >= maxUserFetch) break;

      entries++;
      user_ids.push(elem.user.id);

      await redisClient.zadd(`score_${mode}`, elem.ranked_score, elem.user.id);
      await redisClient.hset("user_id_to_username", elem.user.id, elem.user.username);
      await redisClient.hset("username_to_user_id", elem.user.username, elem.user.id);

      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query(
          "SELECT `rank` FROM osu_score_rank_highest WHERE user_id = ? AND mode = ?",
          [elem.user.id, MODES[mode]]
        );

        const rank = await redisClient.zrevrank(`score_${mode}`, elem.user.id);
        if (!rows[0] || rank + 1 < rows[0].rank) {
          await conn.query(
            "INSERT INTO osu_score_rank_highest (user_id, mode, `rank`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `rank`=?",
            [elem.user.id, MODES[mode], rank + 1, rank + 1]
          );
        }
      } finally {
        conn.release();
      }
    }

    if (entries < maxUserFetch && res.data.cursor_string != null) {
      await sleep(50);
      return fullRankingsUpdate(mode, type, res.data.cursor_string, entries);
    } else {
      // cleanup
      const redis_users = await redisClient.zrange(`score_${mode}`, 0, -1);
      for (const id of redis_users) {
        if (!user_ids.includes(Number(id))) {
          await redisClient.zrem(`score_${mode}`, id);
          console.log("Removed user_id:", id);
        }
      }
      console.log("Finished iterating for a total of " + entries + " Entries!");
      user_ids = [];
      return;
    }
  } catch (err) {
    if (retries[mode][type] < 4) {
      console.log(err);
      console.log("Retry: " + retries[mode][type]);
      retries[mode][type]++;
      await sleep(1000 * (retries[mode][type] * 10));
      return fullRankingsUpdate(mode, type, cursor_string, entries);
    } else {
      console.log("Max retries reached, giving up.");
      retries[mode][type] = 0;
      return;
    }
  }
}

let m = -1;

async function updateAll() {
  console.log("updateAll called, done =", done, "mode =", m);
  if (!done) {
    console.log("fetching not done yet, waiting for next interval.");
    return;
  }
  done = false;

  m++;
  if (m > 3) m = 0;

  switch (m) {
    case 0:
      console.log("Starting fetch for osu!");
      await fullRankingsUpdate("osu", "score", 1);
      break;
    case 1:
      console.log("Starting fetch for osu!taiko");
      await fullRankingsUpdate("taiko", "score", 1);
      break;
    case 2:
      console.log("Starting fetch for osu!catch");
      await fullRankingsUpdate("fruits", "score", 1);
      break;
    case 3:
      console.log("Starting fetch for osu!mania");
      await fullRankingsUpdate("mania", "score", 1);
      break;
  }
  done = true;
  console.log("Fetch done for mode", m);
}

function startFetch() {
  updateAll();
  // 30sec between each mode
  setInterval(updateAll, 30000);
  // lets do some api abuse, as this server doesnt use the osu api that much
  /* 
    Current rate limit is set at an insanely high 1200 requests per minute,
    with burst capability of up to 200 beyond that.
    If you require more, you probably fall into the above category of abuse.
    If you are doing more than 60 requests a minute,
    you should probably give peppy a yell.
  */


}

startFetch();

