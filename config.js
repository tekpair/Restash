// Restash — front-end configuration.
//
// Fill these in with YOUR Supabase project's values, then commit:
//   Supabase dashboard -> Project Settings -> API
//     - Project URL        -> SUPABASE_URL
//     - Project API keys -> "anon"/"publishable" key -> SUPABASE_ANON_KEY
//
// The anon key is SAFE to expose in the browser — it is the public key and
// Row-Level Security controls what it can read/write. Never put the
// service-role/secret key here.
window.RESTASH_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLISHABLE-KEY',

  // Optional: a Google Maps API key (with the Places API enabled) turns the
  // mailing-address fields at checkout and in the profile into Google address
  // autocomplete. Leave blank to keep them as plain text inputs.
  GOOGLE_MAPS_API_KEY: ''
};
