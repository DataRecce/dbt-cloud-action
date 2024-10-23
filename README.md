# dbt Cloud action

This action lets you trigger a job run on [dbt Cloud](https://cloud.getdbt.com), fetches the `manifest.json` and `catalog.json` artifact, and `git checkout`s the branch that was ran by dbt Cloud.

## Inputs

### Credentials

- `dbt_cloud_url` - dbt Cloud [API URL](https://docs.getdbt.com/dbt-cloud/api-v2#/) (Default: `https://cloud.getdbt.com`)
- `dbt_cloud_token` - dbt Cloud [API token](https://docs.getdbt.com/docs/dbt-cloud/dbt-cloud-api/service-tokens)
- `dbt_cloud_account_id` - dbt Cloud Account ID
- `dbt_cloud_base_job_id` - dbt Cloud Job ID for the base environment in Recce
- `dbt_cloud_current_job_id` - dbt Cloud Job ID for the current environment in
Recce

We recommend passing sensitive variables as GitHub secrets.

### Action configuration

- `failure_on_error` - Boolean to make the action report a failure when dbt-cloud runs. Mark this as `false` to run fal after the dbt-cloud job.
- `interval` - The interval between polls in seconds (Default: `30`)

### dbt Cloud Job configuration

Use any of the [documented options for the dbt API](https://docs.getdbt.com/dbt-cloud/api-v2#tag/Jobs/operation/triggerRun).

- `cause` (Default: `Triggered by a Github Action`)
- `git_sha`
- `git_branch`
- `schema_override`
- `dbt_version_override`
- `threads_override`
- `target_name_override`
- `generate_docs_override`
- `timeout_seconds_override`
- `steps_override`: pass a YAML-parseable string. (e.g. `steps_override: '["dbt seed", "dbt run"]'`)

## Use with [Recce](https://github.com/DataRecce/recce)

You can trigger a dbt Cloud run and it will download the artifacts to be able to run your `recce run` command easily in GitHub Actions.

You have to do certain extra steps described, e.g. setting GitHub Action secrets and your warehouse credentials, here:


### Snowflake Example
```yaml
name: Recce with dbt cloud
on:
  pull_request:
    branches: [main]

jobs:
  check-pull-request:
    name: Prepare for Recce
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-python@v5
        with:
          python-version: "3.10"
          cache: "pip"

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Trigger the dbt cloud job and fetch artifacts for Recce
        uses: datarecce/dbt-cloud-action@main
        id: recce_dbt_cloud_run
        with:
          dbt_cloud_token: ${{ secrets.DBT_CLOUD_API_TOKEN }}
          dbt_cloud_account_id: ${{ secrets.DBT_CLOUD_ACCOUNT_ID }}
          dbt_cloud_base_job_id: ${{ secrets.DBT_CLOUD_BASE_JOB_ID }}
          dbt_cloud_current_job_id: ${{ secrets.DBT_CLOUD_CURRENT_JOB_ID }}
          failure_on_error: true

      - name: Run Recce in cloud mode
        env:
          SNOWFLAKE_ACCOUNT: ${{ secrets.SNOWFLAKE_ACCOUNT }}
          SNOWFLAKE_USER: ${{ secrets.SNOWFLAKE_USER }}
          SNOWFLAKE_PASSWORD: ${{ secrets.SNOWFLAKE_PASSWORD }}
          SNOWFLAKE_SCHEMA: "PR_${{ github.event.pull_request.number }}"
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}
          RECCE_STATE_PASSWORD: ${{ secrets.RECCE_STATE_PASSWORD }}
        run: recce run --cloud

      - name: Prepare Recce Summary
        id: recce-summary
        env:
          SNOWFLAKE_ACCOUNT: ${{ secrets.SNOWFLAKE_ACCOUNT }}
          SNOWFLAKE_USER: ${{ secrets.SNOWFLAKE_USER }}
          SNOWFLAKE_PASSWORD: ${{ secrets.SNOWFLAKE_PASSWORD }}
          SNOWFLAKE_SCHEMA: "PR_${{ github.event.pull_request.number }}"
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}
          RECCE_STATE_PASSWORD: ${{ secrets.RECCE_STATE_PASSWORD }}
        run: |
          set -eo pipefail

          recce summary --cloud > recce_summary.md

          # Add next steps message
          cat << EOF >> recce_summary.md

          ## Next Steps
          To view detailed Recce results:
          1. Checkout the PR branch: \`git checkout ${{ github.event.pull_request.head.ref }}\`
          2. Launch the Recce server: \`recce server --review --cloud\`
          3. Open http://localhost:8000 in your browser
          EOF

          # Truncate summary if it exceeds GitHub's comment size limit
          if [[ $(wc -c < recce_summary.md) -ge 65535 ]]; then
            truncate -s 65000 recce_summary.md
            echo "
            ... (Summary truncated due to size limit)
            
            For the full summary, please check the Job Summary page: ${{github.server_url}}/${{github.repository}}/actions/runs/${{github.run_id}}
            " >> recce_summary.md
          fi

      - name: Comment on pull request
        uses: thollander/actions-comment-pull-request@v2
        with:
          filePath: recce_summary.md
          comment_tag: recce

```


### BigQuery with Service Account Key JSON
This is the example of authentication via service account key JSON by [google-github-actions/auth](https://github.com/google-github-actions/auth?tab=readme-ov-file#inputs-service-account-key-json).

Remember to set the secrets in GitHub:
- `DBT_CLOUD_API_TOKEN`
- `GCP_SERVICE_ACCOUNT_KEY_JSON` (suggest to minify it before storing it in the
GitHub Secret)
- `GH_TOKEN`
- `RECCE_STATE_PASSWORD`

And set dbt Cloud IDs while configuring the GitHub Action:
- `dbt_cloud_account_id`
- `dbt_cloud_base_job_id`
- `dbt_cloud_current_job_id`

Please check [profile.yml](https://github.com/DataRecce/jaffle-shop-bigquery/blob/main/profiles.yml) and [recce_ci.yml](https://github.com/DataRecce/jaffle-shop-bigquery/blob/main/.github/workflows/recce_ci.yml) in our example repo for more details.

```yaml
name: Recce with dbt cloud
on:
  pull_request:
    branches: [main]

jobs:
  check-pull-request:
    name: Prepare for Recce
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-python@v5
        with:
          python-version: "3.10"
          cache: "pip"

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Trigger the dbt cloud job and fetch artifacts for Recce
        uses: datarecce/dbt-cloud-action@main
        id: recce_dbt_cloud_run
        with:
          dbt_cloud_token: ${{ secrets.DBT_CLOUD_API_TOKEN }}
          dbt_cloud_account_id: 62083
          dbt_cloud_base_job_id: 747906
          dbt_cloud_current_job_id: 747907
          failure_on_error: true

      - uses: "google-github-actions/auth@v2"
        id: google-auth
        with:
          credentials_json: ${{ secrets.GCP_SERVICE_ACCOUNT_KEY_JSON }}

      - name: Run Recce in cloud mode
        env:
          BQ_PROJECT: ${{ steps.google-auth.outputs.project_id }}
          BQ_DATASET: recce_ci
          BQ_KEYFILE_PATH: ${{ steps.google-auth.outputs.credentials_file_path }}
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}
          RECCE_STATE_PASSWORD: ${{ secrets.RECCE_STATE_PASSWORD }}
        run: recce run --cloud

      - name: Prepare Recce Summary
        id: recce-summary
        env:
          BQ_PROJECT: ${{ steps.google-auth.outputs.project_id }}
          BQ_DATASET: recce_ci
          BQ_KEYFILE_PATH: ${{ steps.google-auth.outputs.credentials_file_path }}
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}
          RECCE_STATE_PASSWORD: ${{ secrets.RECCE_STATE_PASSWORD }}
        run: |
          set -eo pipefail

          recce summary --cloud > recce_summary.md

          # Add next steps message
          cat << EOF >> recce_summary.md

          ## Next Steps
          To view detailed Recce results:
          1. Checkout the PR branch: \`git checkout ${{ github.event.pull_request.head.ref }}\`
          2. Launch the Recce server: \`recce server --review --cloud\`
          3. Open http://localhost:8000 in your browser
          EOF

          # Truncate summary if it exceeds GitHub's comment size limit
          if [[ $(wc -c < recce_summary.md) -ge 65535 ]]; then
            truncate -s 65000 recce_summary.md
            echo "
            ... (Summary truncated due to size limit)

            For the full summary, please check the Job Summary page: ${{github.server_url}}/${{github.repository}}/actions/runs/${{github.run_id}}
            " >> recce_summary.md
          fi

      - name: Comment on pull request
        uses: thollander/actions-comment-pull-request@v2
        with:
          filePath: recce_summary.md
          comment_tag: recce
```
