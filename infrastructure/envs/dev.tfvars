# Dev environment (tofu workspace "dev"). Deployed by `./deploy.sh --env dev`
# and by GitHub Actions on every push to the `dev` branch.
# No secrets belong here; secret values live in Secrets Manager.

# Every resource name is prefixed with this, so nothing collides with prod.
project_name = "qlio-dev"
stage        = "dev"

# Dev's own Remotion bundle, so preview changes never touch prod exports.
remotion_site_name = "qlio-dev-renderer"

# Shared with prod: prod owns these, dev must not manage them.
manage_remotion_bucket_cors = false
create_external_users       = false

# Reuse prod's OpenRouter key instead of creating a second one.
openrouter_secret_name = "zeevee/openrouter-api-key"

# TwelveLabs: indexing callbacks go to whatever webhook the index is set up
# with. To test indexing in dev, create a separate index in TwelveLabs whose
# webhook points at dev's /webhook URL, and put its ID here.
# twelve_labs_index_id = "<dev index id>"
