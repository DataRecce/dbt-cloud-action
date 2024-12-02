const axios = require('axios');
const core = require('@actions/core');
const fs = require('fs');
const axiosRetry = require('axios-retry');
const YAML = require('yaml');

axiosRetry(axios, {
  retryDelay: (retryCount) => retryCount * 1000,
  retries: 3,
  shouldResetTimeout: true,
  onRetry: (retryCount, error, requestConfig) => {
    console.error('Error in request. Retrying...');
  },
});

const RUN_STATUS = {
  1: 'Queued',
  2: 'Starting',
  3: 'Running',
  10: 'Success',
  20: 'Error',
  30: 'Cancelled',
};

const DBT_CLOUD_API = axios.create({
  baseURL: `${core.getInput('dbt_cloud_url')}/api/v2/`,
  timeout: 5000, // 5 seconds
  headers: {
    'Authorization': `Token ${core.getInput('dbt_cloud_token')}`,
    'Content-Type': 'application/json',
  },
});

const ARTIFACTS = ['manifest.json', 'catalog.json'];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const OPTIONAL_KEYS = [
  'git_sha',
  'git_branch',
  'schema_override',
  'dbt_version_override',
  'threads_override',
  'target_name_override',
  'generate_docs_override',
  'timeout_seconds_override',
  'steps_override',
];

const BOOL_OPTIONAL_KEYS = ['generate_docs_override'];
const INTEGER_OPTIONAL_KEYS = ['threads_override', 'timeout_seconds_override'];
const YAML_PARSE_OPTIONAL_KEYS = ['steps_override'];

async function runJob(accountId, job_id) {
  const cause = core.getInput('cause');

  const body = { cause };

  for (const key of OPTIONAL_KEYS) {
    let input = core.getInput(key);

    if (input != '' && BOOL_OPTIONAL_KEYS.includes(key)) {
      input = core.getBooleanInput(key);
    } else if (input != '' && INTEGER_OPTIONAL_KEYS.includes(key)) {
      input = parseInt(input);
    } else if (input != '' && YAML_PARSE_OPTIONAL_KEYS.includes(key)) {
      core.debug(input);
      try {
        input = YAML.parse(input);
        if (typeof input == 'string') {
          input = [input];
        }
      } catch (e) {
        core.setFailed(
          `Could not interpret ${key} correctly. Pass valid YAML in a string.\n Example:\n  property: '['a string', 'another string']'`
        );
        throw e;
      }
    }

    // Type-checking equality becuase of boolean inputs
    if (input !== '') {
      body[key] = input;
    }
  }

  core.debug(`Run job body:\n${JSON.stringify(body, null, 2)}`);

  let res = await DBT_CLOUD_API.post(`/accounts/${accountId}/jobs/${job_id}/run/`, body);
  return res.data;
}

async function getJobRun(accountId, run_id) {
  try {
    let res = await DBT_CLOUD_API.get(
      `/accounts/${accountId}/runs/${run_id}/?include_related=["run_steps"]`
    );
    return res.data;
  } catch (e) {
    let errorMsg = e.toString();
    if (errorMsg.search('timeout of ') != -1 && errorMsg.search(' exceeded') != -1) {
      // Special case for axios timeout
      errorMsg += '. The dbt Cloud API is taking too long to respond.';
    }

    console.error('Error getting job information from dbt Cloud. ' + errorMsg);
  }
}

async function getJobArtifacts(accountId, jobId) {
  const saveDir = './target-base';
  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir);
  }

  for (const artifact of ARTIFACTS) {
    try {
      core.info(`Fetching ${artifact} for the base environment`);
      let res = await DBT_CLOUD_API.get(
        `/accounts/${accountId}/jobs/${jobId}/artifacts/${artifact}`
      );
      core.info(`Saving ${artifact} in ${saveDir}`);
      fs.writeFileSync(`${saveDir}/${artifact}`, JSON.stringify(res.data));
    } catch (error) {
      if (artifact === 'catalog.json' && error.response && error.response.status === 404) {
        core.notice(`catalog.json not found in the base job. Skipping download.`);
      } else {
        throw error;
      }
    }
  }
}

async function getRunArtifacts(accountId, runId) {
  const saveDir = './target';
  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir);
  }

  for (const artifact of ARTIFACTS) {
    try {
      core.info(`Fetching ${artifact} for the current environment`);
      let res = await DBT_CLOUD_API.get(
        `/accounts/${accountId}/runs/${runId}/artifacts/${artifact}`
      );
      core.info(`Saving ${artifact} in ${saveDir}`);
      fs.writeFileSync(`${saveDir}/${artifact}`, JSON.stringify(res.data));
    } catch (error) {
      if (artifact === 'catalog.json' && error.response && error.response.status === 404) {
        core.notice(`catalog.json not found in the current run. Skipping download.`);
      } else {
        throw error;
      }
    }
  }
}

async function executeAction() {
  const accountId = core.getInput('dbt_cloud_account_id');
  const baseJobId = core.getInput('dbt_cloud_base_job_id');
  const currentJobId = core.getInput('dbt_cloud_current_job_id');
  const failure_on_error = core.getBooleanInput('failure_on_error');

  const currentJobRun = await runJob(accountId, currentJobId);
  const currentRunId = currentJobRun.data.id;

  core.info(`Triggered job. ${currentJobRun.data.href}`);

  let res;
  while (true) {
    await sleep(core.getInput('interval') * 1000);
    res = await getJobRun(accountId, currentRunId);

    if (!res) {
      // Retry if there is no response
      continue;
    }

    let status = RUN_STATUS[res.data.status];
    core.info(`Run: ${res.data.id} - ${status}`);

    if (core.getBooleanInput('wait_for_job')) {
      if (res.data.is_complete) {
        core.info(`job finished with '${status}'`);
        break;
      }
    } else {
      core.info('Not waiting for job to finish. Relevant run logs will be omitted.');
      break;
    }
  }

  if (res.data.is_error && failure_on_error) {
    core.setFailed();
  }

  if (res.data.is_error) {
    // Wait for the step information to load in run
    core.info('Loading logs...');
    await sleep(5000);
    res = await getJobRun(accountId, currentRunId);
    // Print logs
    for (let step of res.data.run_steps) {
      core.info('# ' + step.name);
      core.info(step.logs);
      core.info('\n************\n');
    }
  }

  // Download artifact for the base environment
  await getJobArtifacts(accountId, baseJobId);

  // Download artifact for the current environment
  await getRunArtifacts(accountId, currentRunId);

  const outputs = {
    git_sha: res.data['git_sha'],
    run_id: currentRunId,
  };

  return outputs;
}

async function main() {
  try {
    const outputs = await executeAction();
    const git_sha = outputs['git_sha'];
    const run_id = outputs['run_id'];

    // GitHub Action output
    core.info(`dbt Cloud Job commit SHA is ${git_sha}`);
    core.setOutput('git_sha', git_sha);
    core.setOutput('run_id', run_id);
  } catch (e) {
    // Always fail in this case because it is not a dbt error
    core.setFailed('There has been a problem with running your dbt cloud job:\n' + e.toString());
    core.debug(e.stack);
  }
}

main();
