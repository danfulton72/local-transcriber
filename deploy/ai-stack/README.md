# Talk to Type inside the R720 AI stack

This integration moves Talk to Type into the existing /home/dan/ai Compose project without duplicating the full AI-stack configuration in this repo.

## Resulting layout

    /home/dan/local-transcriber/                 Git working tree
    /home/dan/ai/local-transcriber/app.env       runtime app configuration
    /home/dan/ai/local-transcriber/recordings/   retained WAV files
    /home/dan/ai/local-transcriber/runtime/      T4 arbitration busy-file
    /databases/aimodels/talk-to-type/pyannote/   Hugging Face / pyannote cache

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

## T4 ownership

The installer extends the existing T4 matrix with a new variable and exclusive set:

    matrix:
      vars:
        s: speaker_auto
      sets:
        speaker_only: "s"

It also adds a hidden model:

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

The analyzer creates /run/talk-to-type/speaker.busy for the duration of pyannote. speaker-stop.sh waits for that file to disappear before llama-swap may stop the reservation and load another T4 model. The persistent Whisper workload is not managed by llama-swap and remains loaded.

Talk to Type snapshots /running before analysis. On normal completion it unloads speaker_auto, checks whether another request already claimed the T4, and if not wakes the models that were running before analysis. An interactive request arriving at the end of analysis therefore wins over automatic restoration.

## Install / migrate

From the Docker host:

    cd /home/dan/local-transcriber
    git pull
    python deploy/ai-stack/install.py

The installer:

- backs up /home/dan/ai/llama-swap/t4.yaml;
- patches the T4 matrix and adds speaker_auto;
- links /home/dan/ai/compose.override.yml to the integration overlay;
- copies .env to /home/dan/ai/local-transcriber/app.env if needed;
- copies the old recordings directory if the AI-stack destination is empty;
- copies the old speaker-model-cache if the shared model destination is empty;
- runs docker compose config -q in /home/dan/ai.

It never deletes the old recordings or model cache.

Review the runtime environment:

    nano /home/dan/ai/local-transcriber/app.env

Ensure HF_TOKEN, database credentials, parent PIN, and login bootstrap values are correct.

Then stop the old standalone containers and start the integrated stack:

    cd /home/dan/local-transcriber
    docker compose down

    cd /home/dan/ai
    docker compose up -d --build

From then on the normal AI-stack command manages Talk to Type too:

    cd /home/dan/ai
    docker compose up -d
    docker compose ps

## Verify

Check services:

    cd /home/dan/ai
    docker compose ps local-transcriber speaker-analyzer llama-swap-t4
    curl http://localhost:8090/healthz
    curl http://127.0.0.1:9293/running

Confirm the analyzer sees only the T4:

    docker compose exec speaker-analyzer python -c 'import torch; print(torch.cuda.get_device_name(0)); print(torch.cuda.get_device_capability(0)); print(torch.cuda.get_arch_list())'

Expected device:

    Tesla T4
    (7, 5)

When a parent starts conversation analysis, /running should temporarily show speaker_auto and the large T4 Qwen model should disappear. When analysis finishes, the previous Qwen/embedding set should return unless another request has already selected a different T4 model.

Useful live diagnostics:

    watch -n1 'curl -s http://127.0.0.1:9293/running'
    docker compose logs -f llama-swap-t4 speaker-analyzer local-transcriber
    nvidia-smi

## Model and state storage

The integrated layout separates source from persistent state:

- source checkout: /home/dan/local-transcriber
- app config/state: /home/dan/ai/local-transcriber
- large ML cache: /databases/aimodels/talk-to-type/pyannote

This keeps Hugging Face model downloads beside the rest of the AI model store rather than inside the Git checkout.

## Rollback

The installer leaves the old standalone data intact.

1. Stop local-transcriber and speaker-analyzer in the AI stack.
2. Remove /home/dan/ai/compose.override.yml if it is the Talk to Type symlink.
3. Restore the timestamped t4.yaml.before-talk-to-type-* backup.
4. Restart llama-swap-t4.
5. Start the original standalone Compose project.

PostgreSQL is unchanged by moving the containers between Compose projects.
