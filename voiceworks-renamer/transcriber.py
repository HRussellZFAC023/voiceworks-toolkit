"""
Multi-device Whisper transcriber with automatic hardware detection
and distributed inference across GPU + NPU.

Backends:
  - faster-whisper (CTranslate2): NVIDIA CUDA, AMD ROCm
  - OpenVINO GenAI: Intel CPU / Intel GPU (XPU) / Intel NPU
  - ONNX Runtime: AMD iGPU (DirectML), AMD NPU (VitisAI)

When multiple accelerators are detected (e.g. AMD iGPU + NPU),
concurrent callers are automatically distributed across devices
via an internal device pool — no caller changes needed.
"""

import logging
import os
import queue
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ── Accelerator detection ────────────────────────────────────────────


@dataclass
class Accelerator:
    """A detected hardware accelerator capable of running Whisper."""

    id: str  # unique key, e.g. 'cuda', 'dml-gpu', 'amd-npu'
    name: str  # human-readable, e.g. 'NVIDIA GeForce RTX 4090'
    backend: str  # 'faster-whisper' | 'openvino' | 'onnx'
    priority: int  # lower = preferred when building pool
    device: str = ""  # backend-specific device string
    provider: str = ""  # ONNX Runtime execution provider name
    provider_options: Dict[str, str] = field(default_factory=dict)
    compute_type: str = ""  # for faster-whisper precision


def _find_vaip_config() -> Optional[str]:
    """Locate AMD vaip_config.json required by VitisAI EP."""
    # 1. Explicit env var
    for var in ("VAIP_CONFIG", "VAIP_CONFIG_PATH"):
        path = os.environ.get(var)
        if path and os.path.isfile(path):
            return path

    # 2. Search common AMD Ryzen AI install locations
    for base in (r"C:\RyzenAI", r"C:\AMD\RyzenAI"):
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            if "vaip_config.json" in files:
                return os.path.join(root, "vaip_config.json")

    return None


def detect_accelerators() -> List[Accelerator]:
    """Probe the system for every available Whisper-capable accelerator."""
    found: List[Accelerator] = []

    # ── 1. NVIDIA CUDA (faster-whisper) ──
    try:
        import torch

        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            found.append(
                Accelerator(
                    id="cuda",
                    name=f"NVIDIA {gpu_name}",
                    backend="faster-whisper",
                    priority=10,
                    device="cuda",
                    compute_type="float16",
                )
            )
    except ImportError:
        pass

    # ── 2. AMD ROCm (faster-whisper) ──
    try:
        import torch

        if (
            not torch.cuda.is_available()
            and hasattr(torch.version, "hip")
            and torch.version.hip
        ):
            found.append(
                Accelerator(
                    id="rocm",
                    name="AMD GPU (ROCm)",
                    backend="faster-whisper",
                    priority=15,
                    device="cuda",  # ROCm maps to 'cuda' in faster-whisper
                    compute_type="float16",
                )
            )
    except ImportError:
        pass

    # ── 3. ONNX Runtime EPs — AMD iGPU (DirectML) + AMD NPU (VitisAI) ──
    try:
        import onnxruntime as ort

        eps = ort.get_available_providers()

        if "DmlExecutionProvider" in eps:
            found.append(
                Accelerator(
                    id="dml-gpu",
                    name="GPU (DirectML)",
                    backend="onnx",
                    priority=20,
                    provider="DmlExecutionProvider",
                )
            )

        if "VitisAIExecutionProvider" in eps:
            vaip_cfg = _find_vaip_config()
            if vaip_cfg:
                found.append(
                    Accelerator(
                        id="amd-npu",
                        name="AMD NPU (XDNA)",
                        backend="onnx",
                        priority=25,
                        provider="VitisAIExecutionProvider",
                        provider_options={"config_file": vaip_cfg},
                    )
                )
            else:
                logger.warning(
                    "VitisAI EP detected but vaip_config.json not found. "
                    "Set VAIP_CONFIG env var or install AMD Ryzen AI Software."
                )
    except ImportError:
        pass

    # ── 4. OpenVINO devices — Intel GPU + Intel NPU ──
    try:
        from openvino import Core

        ov_devices = Core().available_devices

        if "GPU" in ov_devices:
            found.append(
                Accelerator(
                    id="intel-gpu",
                    name="Intel GPU (OpenVINO)",
                    backend="openvino",
                    priority=20,
                    device="GPU",
                )
            )

        if "NPU" in ov_devices:
            found.append(
                Accelerator(
                    id="intel-npu",
                    name="Intel NPU (OpenVINO)",
                    backend="openvino",
                    priority=25,
                    device="NPU",
                )
            )
    except ImportError:
        pass

    # ── 5. CPU fallback ──
    # Prefer OpenVINO CPU if available, otherwise faster-whisper CPU
    cpu_backend = "faster-whisper"
    try:
        from openvino_genai import WhisperPipeline  # noqa: F401

        cpu_backend = "openvino"
    except ImportError:
        pass

    found.append(
        Accelerator(
            id="cpu",
            name="CPU",
            backend=cpu_backend,
            priority=100,
            device="CPU" if cpu_backend == "openvino" else "cpu",
            compute_type="int8",
        )
    )

    found.sort(key=lambda a: a.priority)
    return found


# ── Transcriber ──────────────────────────────────────────────────────


class Transcriber:
    """
    Multi-device Whisper transcriber with device-pool distribution.

    Config keys:
      accelerator   – "auto" (default) or force a specific id
                      ("cuda", "dml-gpu", "amd-npu", "intel-npu", "cpu", …)
      distributed   – true (default): use all detected accelerators
                      concurrently; false: use only the best one
      model_dir_openvino  – OpenVINO IR model directory
      model_name_faster   – faster-whisper model id / path
      model_name_onnx     – HuggingFace model id for ONNX export
    """

    def __init__(self, config):
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.default_language = "ja"

        # ── Model references ──
        self.default_model_openvino = "kotoba-whisper-v2.0"
        self.default_model_faster = "kotoba-tech/kotoba-whisper-v2.0-faster"
        self.default_model_onnx = "kotoba-tech/kotoba-whisper-v2.0"

        self.model_dir_openvino = config.get(
            "model_dir_openvino", self.default_model_openvino
        )
        self.model_name_faster = config.get(
            "model_name_faster", self.default_model_faster
        )
        self.model_name_onnx = config.get("model_name_onnx", self.default_model_onnx)

        # ── Hardware detection ──
        all_accs = detect_accelerators()
        forced = config.get("accelerator", "auto")

        if forced != "auto":
            filtered = [a for a in all_accs if a.id == forced]
            if filtered:
                # Keep forced device + CPU fallback
                cpu = [a for a in all_accs if a.id == "cpu"]
                self.accelerators = filtered + cpu
            else:
                self.logger.warning(
                    "Forced accelerator '%s' not available, using auto", forced
                )
                self.accelerators = all_accs
        else:
            self.accelerators = all_accs

        self.logger.info(
            "Detected accelerators: %s",
            [f"{a.name} ({a.id})" for a in self.accelerators],
        )

        # ── Device pool ──
        distributed = config.get("distributed", True)
        pool_accs = [a for a in self.accelerators if a.id != "cpu"]
        if not pool_accs:
            pool_accs = [a for a in self.accelerators if a.id == "cpu"][:1]

        if not distributed:
            pool_accs = pool_accs[:1]

        self.device_pool: queue.Queue[Accelerator] = queue.Queue()
        for acc in pool_accs:
            self.device_pool.put(acc)
            self.logger.info(
                "Device pool: %s [%s backend]", acc.name, acc.backend
            )

        if len(pool_accs) > 1:
            self.logger.info(
                "Distributed mode active — %d devices will share work",
                len(pool_accs),
            )

        # ── Per-device model cache + locks ──
        self._models: Dict[str, Any] = {}
        self._model_locks: Dict[str, Lock] = {
            a.id: Lock() for a in self.accelerators
        }

    # ── Public API (unchanged for callers) ───────────────────────────

    def transcribe_file(self, file_path: str, rjcode: str) -> Optional[dict]:
        """
        Transcribe an audio file on the best available device.

        Thread-safe: concurrent callers from the folder ThreadPoolExecutor
        are automatically routed to different devices in the pool.
        """
        filename = Path(file_path).name
        if not os.path.exists(file_path):
            self.logger.error("[%s] File not found: '%s'", rjcode, filename)
            return None

        acc = self.device_pool.get()
        try:
            self.logger.info(
                "[%s] Transcribing '%s' on %s", rjcode, filename, acc.name
            )
            result = self._transcribe_on(acc, file_path, rjcode)
            if result is not None:
                return result

            # Primary device failed — try CPU fallback
            cpu = next((a for a in self.accelerators if a.id == "cpu"), None)
            if cpu and cpu.id != acc.id:
                self.logger.warning(
                    "[%s] %s failed, falling back to CPU", rjcode, acc.name
                )
                return self._transcribe_on(cpu, file_path, rjcode)

            return None
        finally:
            self.device_pool.put(acc)

    # ── Backend dispatch ─────────────────────────────────────────────

    def _transcribe_on(
        self, acc: Accelerator, file_path: str, rjcode: str
    ) -> Optional[dict]:
        try:
            if acc.backend == "faster-whisper":
                return self._transcribe_faster_whisper(acc, file_path, rjcode)
            elif acc.backend == "openvino":
                return self._transcribe_openvino(acc, file_path, rjcode)
            elif acc.backend == "onnx":
                return self._transcribe_onnx(acc, file_path, rjcode)
            else:
                self.logger.error("Unknown backend: %s", acc.backend)
                return None
        except Exception as e:
            self.logger.error(
                "[%s] %s failed on %s: %s", rjcode, acc.backend, acc.name, e
            )
            self.logger.error(traceback.format_exc())
            return None

    # ── OpenVINO backend (Intel CPU / GPU / NPU) ────────────────────

    def _load_openvino(self, acc: Accelerator):
        with self._model_locks[acc.id]:
            if acc.id not in self._models:
                from openvino_genai import WhisperPipeline

                model_dir = self.model_dir_openvino
                self.logger.info(
                    "Loading OpenVINO model '%s' for %s…", model_dir, acc.name
                )
                try:
                    self._models[acc.id] = WhisperPipeline(
                        model_dir, device=acc.device
                    )
                except Exception:
                    if model_dir != self.default_model_openvino:
                        self.logger.warning("Retrying with default model…")
                        model_dir = self.default_model_openvino
                        self._models[acc.id] = WhisperPipeline(
                            model_dir, device=acc.device
                        )
                    else:
                        raise
                self.logger.info("OpenVINO model ready on %s", acc.name)
        return self._models[acc.id]

    def _transcribe_openvino(
        self, acc: Accelerator, file_path: str, rjcode: str
    ) -> Optional[dict]:
        import librosa

        model = self._load_openvino(acc)
        raw_speech, _ = librosa.load(file_path, sr=16000)

        result = model.generate(
            raw_speech.tolist(),
            language=f"<|{self.default_language}|>",
            task="transcribe",
            return_timestamps=True,
        )

        segments = [
            {"text": c.text, "timestamp": (c.start_ts, c.end_ts)}
            for c in result.chunks
        ]
        return self._format_result(segments, file_path)

    # ── faster-whisper backend (NVIDIA CUDA / AMD ROCm) ─────────────

    def _load_faster_whisper(self, acc: Accelerator):
        with self._model_locks[acc.id]:
            if acc.id not in self._models:
                from faster_whisper import WhisperModel

                model_name = self.model_name_faster
                self.logger.info(
                    "Loading faster-whisper '%s' for %s…", model_name, acc.name
                )
                try:
                    self._models[acc.id] = WhisperModel(
                        model_name,
                        device=acc.device,
                        compute_type=acc.compute_type,
                    )
                except Exception:
                    if model_name != self.default_model_faster:
                        self.logger.warning("Retrying with default model…")
                        model_name = self.default_model_faster
                        self._models[acc.id] = WhisperModel(
                            model_name,
                            device=acc.device,
                            compute_type=acc.compute_type,
                        )
                    else:
                        raise
                self.logger.info("faster-whisper model ready on %s", acc.name)
        return self._models[acc.id]

    def _transcribe_faster_whisper(
        self, acc: Accelerator, file_path: str, rjcode: str
    ) -> Optional[dict]:
        model = self._load_faster_whisper(acc)

        try:
            segs_iter, _info = model.transcribe(
                file_path,
                language=self.default_language,
                chunk_length=15,
                condition_on_previous_text=False,
            )
            segments = [
                {"text": s.text, "timestamp": (s.start, s.end)}
                for s in segs_iter
            ]
            return self._format_result(segments, file_path)

        except Exception as e:
            # Handle CUDA OOM specifically
            try:
                import torch

                if isinstance(e, torch.cuda.OutOfMemoryError):
                    self.logger.error(
                        "[%s] CUDA OOM: '%s'", rjcode, Path(file_path).name
                    )
                    torch.cuda.empty_cache()
                    return None
            except ImportError:
                pass
            raise

    # ── ONNX Runtime backend (AMD iGPU + AMD NPU) ───────────────────

    def _load_onnx(self, acc: Accelerator):
        with self._model_locks[acc.id]:
            if acc.id not in self._models:
                from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
                from transformers import AutoProcessor
                from transformers import pipeline as hf_pipeline

                model_name = self.model_name_onnx
                self.logger.info(
                    "Loading ONNX model '%s' for %s (%s)…",
                    model_name,
                    acc.name,
                    acc.provider,
                )

                opts = acc.provider_options if acc.provider_options else None
                try:
                    ort_model = ORTModelForSpeechSeq2Seq.from_pretrained(
                        model_name,
                        export=True,
                        provider=acc.provider,
                        provider_options=opts,
                    )
                except Exception:
                    if model_name != self.default_model_onnx:
                        self.logger.warning("Retrying with default model…")
                        model_name = self.default_model_onnx
                        ort_model = ORTModelForSpeechSeq2Seq.from_pretrained(
                            model_name,
                            export=True,
                            provider=acc.provider,
                            provider_options=opts,
                        )
                    else:
                        raise

                processor = AutoProcessor.from_pretrained(model_name)
                self._models[acc.id] = hf_pipeline(
                    "automatic-speech-recognition",
                    model=ort_model,
                    tokenizer=processor.tokenizer,
                    feature_extractor=processor.feature_extractor,
                    chunk_length_s=15,
                )
                self.logger.info("ONNX model ready on %s", acc.name)
        return self._models[acc.id]

    def _transcribe_onnx(
        self, acc: Accelerator, file_path: str, rjcode: str
    ) -> Optional[dict]:
        pipe = self._load_onnx(acc)

        result = pipe(
            file_path,
            return_timestamps=True,
            generate_kwargs={
                "language": self.default_language,
                "task": "transcribe",
            },
        )

        chunks = result.get("chunks", [])
        segments = [
            {"text": c["text"], "timestamp": c.get("timestamp", (0, 0))}
            for c in chunks
        ]
        return self._format_result(segments, file_path)

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _format_result(segments: list, file_path: str) -> dict:
        return {
            "text": "\n".join(s["text"] for s in segments).strip(),
            "segments": segments,
            "original_filename": Path(file_path).stem,
            "speaker_ids": [],
        }
