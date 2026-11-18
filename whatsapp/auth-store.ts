// Baileys login state (the linked device's keys) kept in Postgres instead of files,
// so the bridge needs no volume and survives restarts and moves between nodes.
// Values are never logged; the app's API never reads this table.
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import type postgres from "postgres";

const CREDS = "creds";

export async function usePostgresAuthState(sql: postgres.Sql) {
  const encode = (v: unknown) => JSON.stringify(v, BufferJSON.replacer);
  const decode = (s: string) => JSON.parse(s, BufferJSON.reviver);

  const [row] = await sql`select value from wa_auth where key = ${CREDS}`;
  const creds: AuthenticationCreds = row ? decode(row.value) : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return out;
        const rows = await sql`select key, value from wa_auth where key in ${sql(ids.map((id) => `${type}-${id}`))}`;
        const byKey = new Map(rows.map((r) => [r.key as string, r.value as string]));
        for (const id of ids) {
          const raw = byKey.get(`${type}-${id}`);
          if (!raw) continue;
          let v = decode(raw);
          if (type === "app-state-sync-key") v = proto.Message.AppStateSyncKeyData.fromObject(v);
          out[id] = v;
        }
        return out;
      },
      set: async (data) => {
        await sql.begin(async (tx) => {
          for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const [id, value] of Object.entries(data[type] ?? {})) {
              const key = `${type}-${id}`;
              if (value)
                await tx`insert into wa_auth (key, value) values (${key}, ${encode(value)})
                  on conflict (key) do update set value = excluded.value, updated_at = now()`;
              else await tx`delete from wa_auth where key = ${key}`;
            }
          }
        });
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await sql`insert into wa_auth (key, value) values (${CREDS}, ${encode(creds)})
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
    },
    /** Forget the linked device entirely (after a logout). */
    clear: async () => {
      await sql`delete from wa_auth`;
    },
  };
}
