// `src/lib/supabase.ts` decides two things at import time and never again: whether the catalog
// is configured, and what the client was constructed with. Both are read from `process.env`, so
// each branch needs its own module instance — hence `jest.isolateModules` plus env mutation.
//
// `createClient` is mocked because the real one opens a fetch-backed client at import; the
// mock instance is fetched *inside* each isolated registry so the recorded calls belong to the
// same instance the module under test received.

jest.mock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => ({})) }));

const URL_VAR = "EXPO_PUBLIC_SUPABASE_URL";
const KEY_VAR = "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

const AUTH_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

type SupabaseModule = typeof import("@/lib/supabase");

/** Load the module against the current env and hand back it plus its own `createClient` spy. */
function loadFresh(): { module: SupabaseModule; createClient: jest.Mock } {
  let module!: SupabaseModule;
  let createClient!: jest.Mock;
  jest.isolateModules(() => {
    module = require("@/lib/supabase") as SupabaseModule;
    createClient = (require("@supabase/supabase-js") as { createClient: jest.Mock })
      .createClient;
  });
  return { module, createClient };
}

describe("supabase client", () => {
  const original = { url: process.env[URL_VAR], key: process.env[KEY_VAR] };

  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  afterEach(() => {
    restore(URL_VAR, original.url);
    restore(KEY_VAR, original.key);
  });

  it("reports the catalog as configured and passes both values through", () => {
    process.env[URL_VAR] = "https://example.supabase.co";
    process.env[KEY_VAR] = "sb_publishable_example";

    const { module, createClient } = loadFresh();

    expect(module.glazeCatalogConfigured).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "sb_publishable_example",
      AUTH_OPTIONS
    );
    expect(module.supabase).toBeDefined();
  });

  it("still constructs a client from placeholders when nothing is configured", () => {
    delete process.env[URL_VAR];
    delete process.env[KEY_VAR];

    const { module, createClient } = loadFresh();

    expect(module.glazeCatalogConfigured).toBe(false);
    expect(createClient).toHaveBeenCalledWith("http://localhost", "unset", AUTH_OPTIONS);
    // The module must still export a usable object — screens import it unconditionally and
    // gate on `glazeCatalogConfigured` instead.
    expect(module.supabase).toBeDefined();
  });

  it("treats a half-configured environment as unconfigured", () => {
    process.env[URL_VAR] = "https://example.supabase.co";
    delete process.env[KEY_VAR];

    const { module, createClient } = loadFresh();

    expect(module.glazeCatalogConfigured).toBe(false);
    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "unset",
      AUTH_OPTIONS
    );
  });

  it("treats an empty url with a present key as unconfigured", () => {
    process.env[URL_VAR] = "";
    process.env[KEY_VAR] = "sb_publishable_example";

    const { module, createClient } = loadFresh();

    expect(module.glazeCatalogConfigured).toBe(false);
    expect(createClient).toHaveBeenCalledWith(
      "http://localhost",
      "sb_publishable_example",
      AUTH_OPTIONS
    );
  });
});
