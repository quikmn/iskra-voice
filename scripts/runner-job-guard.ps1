# The home PC's self-hosted runner runs this before every job (ACTIONS_RUNNER_HOOK_JOB_STARTED, set by
# scripts/runner-setup.ps1, which copies this file next to the runner: changing it in the repo changes nothing on the
# PC until setup runs again). A job it refuses fails before any of its steps run.
#
# The runner only takes the Release workflow's own jobs on main, started by the owner by hand (workflow_dispatch):
# never a pull request, a fork, another branch, another workflow or anyone else. The workflow checks the same in its
# `if:`; this is the PC's own check, which a changed workflow file can't remove. Works in Windows PowerShell 5.1 too.
# Tested by scripts/runner.test.mjs.
$expected = [ordered]@{
  GITHUB_REPOSITORY       = 'quikmn/iskra-voice'
  GITHUB_REPOSITORY_ID    = '1227290412'
  GITHUB_EVENT_NAME       = 'workflow_dispatch'
  GITHUB_REF              = 'refs/heads/main'
  GITHUB_WORKFLOW_REF     = 'quikmn/iskra-voice/.github/workflows/release-all.yml@refs/heads/main'
  GITHUB_ACTOR            = 'quikmn'
  GITHUB_TRIGGERING_ACTOR = 'quikmn'
}
# The job ids in release-all.yml that run on this PC.
$jobs = @('pc-checks', 'windows', 'play-pc')

$problems = @()
foreach ($name in $expected.Keys) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value -cne $expected[$name]) { $problems += "$name is '$value', not '$($expected[$name])'" }
}
$job = [Environment]::GetEnvironmentVariable('GITHUB_JOB')
if ($jobs -notcontains $job) { $problems += "job '$job' isn't one of $($jobs -join ', ')" }

if ($problems.Count) {
  Write-Output "This runner (the home PC) only runs the Release workflow's own jobs, started by the owner on main. Refused: $($problems -join '; ')."
  exit 1
}
Write-Output "Runner guard: ok ($job, run $([Environment]::GetEnvironmentVariable('GITHUB_RUN_ID')))."
exit 0
