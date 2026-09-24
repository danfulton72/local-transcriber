# Talk to Type inside the R720 AI stack

Talk to Type is installed as a normal directory inside the existing AI stack:

    /home/dan/ai/local-transcriber/

That directory is the Git checkout and also owns the app's local runtime files.

## Layout

    /home/dan/ai/
      compose.yml
      compose.override.yml -> local-transcriber/deploy/ai-stack/compose.override.yml
      llama-swap/
        t4.yaml
      local-transcriber/
        .git/
        app/
        speaker_service/
        deploy/
        .env
        recordings/
        runtime/

    /databases/aimodels/
      talk-to-type/
        pyannote/

Everything specific to the app stays under /home/dan/ai/local-transcriber except the large pyannote/Hugging Face cache, which lives with the rest of the AI model store.

Both Talk to Type services join the existing ai bridge network.

    local-transcriber
        |
        +---- speaker health ----> speaker-analyzer
        |
        +---- analysis ----------> llama-swap-t4
                                      |
                                 speaker_auto
                                      |
                                      v
                               speaker-analyzer
                                      |
                                   Tesla T4

Whisper, Piper, and the Wyoming OpenAI gateway remain separate and unchanged.

## Clean install

No data migration is assumed.

If an older standalone checkout exists, stop it first:

    cd /home/dan/local-transcriber
    docker compose down

Then clone directly into the AI stack:

    cd /home/dan/ai
    git clone https://github.com/danfulton72/local-transcriber.git
    cd local-transcriber

Run the AI-stack installer:

    python deploy/ai-stack/install.py

The installer will:

- require the checkout to be /home/dan/ai/local-transcriber;
- create recordings/ and runtime/ inside the checkout;
- create /databases/aimodels/talk-to-type/pyannote;
- copy .env.example to .env if .env does not exist;
- back up /home/dan/ai/llama-swap/t4.yaml;
- patch the T4 matrix with the hidden speaker_auto reservation;
- link /home/dan/ai/compose.override.yml to this checkout;
- run docker compose config -q in /home/dan/ai.

It does not copy data from an older installation.

Edit the fresh environment before starting:

    nano /home/dan/ai/local-transcriber/.env

At minimum check:

    DATABASE_URL
    PARENT_PIN
    DEFAULT_USERNAME
    DEFAULT_PASSWORD
    DEFAULT_DISPLAY_NAME
    AUTH_COOKIE_SECURE
    HF_TOKEN

Then start through the main AI stack:

    cd /home/dan/ai
    docker compose up -d --build

From then on the normal AI-stack lifecycle manages Talk to Type:

    cd /home/dan/ai
    docker compose ps
    docker compose up -d
    docker compose logs -f local-transcriber speaker-analyzer llama-swap-t4

The old /home/dan/local-transcriber directory can be removed after you are happy with the new install.

## T4 ownership

The installer extends the existing T4 matrix with:

    matrix:
      vars:
        s: speaker_auto
      sets:
        speaker_only: "s"

and adds this hidden model:

    "speaker_auto":
      unlisted: true
      cmd: "tail -f /dev/null"
      proxy: "http://speaker-analyzer:9000"
      checkEndpoint: /healthz
      ttl: 0
      unloadTimeout: 7200
      concurrencyLimit: 1
      cmdStop: sh /scripts/speaker-stop.sh "${PID}"

Because speaker_only contains only speaker_auto, requesting /upstream/speaker_auto/analyze makes llama-swap unload the T4 Qwen/embedding processes before forwarding the analysis request.

The analyzer creates:

    /run/talk-to-type/speaker.busy

for the duration of pyannote. The same host directory is:

    /home/dan/ai/local-transcriber/runtime/

speaker-stop.sh waits for the busy-file to disappear before llama-swap may stop the reservation and load another T4 model.

The persistent Whisper process is outside this swap and remains loaded.

Talk to Type snapshots /running before analysis. When analysis finishes it unloads speaker_auto, checks whether another request already claimed the T4, and restores the previously-running models only when the card is still free.

## Shared model storage

The speaker analyzer mounts:

    /databases/aimodels/talk-to-type/pyannote -> /models

HF_HOME points at /models, so pyannote/Hugging Face downloads live with the rest of the AI model store rather than inside the Git repository.

## Verify

Check the three relevant services:

    cd /home/dan/ai
    docker compose ps local-transcriber speaker-analyzer llama-swap-t4
    curl http://localhost:8090/healthz
    curl http://127.0.0.1:9293/running

Confirm speaker-analyzer sees only the T4:

    docker compose exec speaker-analyzer python -c 'import torch; print(torch.cuda.get_device_name(0)); print(torch.cuda.get_device_capability(0)); print(torch.cuda.get_arch_list())'

Expected:

    Tesla T4
    (7, 5)

For the first parent-triggered speaker analysis, watch llama-swap:

    watch -n1 'curl -s http://127.0.0.1:9293/running'

You should see the normal T4 Qwen/embedding set disappear, speaker_auto appear during analysis, then the previous set return when analysis finishes unless another request has already selected a different T4 model.

## Updating

Because the checkout now lives inside the AI stack:

    cd /home/dan/ai/local-transcriber
    git pull

    cd /home/dan/ai
    docker compose up -d --build

Rerun the installer after changes to the integration files or T4 arbitration:

    cd /home/dan/ai/local-transcriber
    python deploy/ai-stack/install.py

It is safe to rerun.

## Rollback

The installer backs up t4.yaml before first modification.

To remove the integration:

1. Stop local-transcriber and speaker-analyzer.
2. Remove /home/dan/ai/compose.override.yml if it is the Talk to Type symlink.
3. Restore the timestamped t4.yaml.before-talk-to-type-* backup.
4. Restart llama-swap-t4.

Because this is now treated as a clean installation, no old Talk to Type data migration or rollback is assumed.
