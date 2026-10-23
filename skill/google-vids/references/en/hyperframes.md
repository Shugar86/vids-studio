# Optional local HyperFrames insert

Use the shared [motion-inserts](motion-inserts.md) scope. Use only an already
available, authorized renderer. Locate its CLI in the current project/configuration
and inspect its version/help; another private project's path is not a dependency.
Do not automatically install a runtime or label another renderer HyperFrames.

Keep composition resources local. Retain provenance and the applicable licenses
for third-party runtime/fonts; no GSAP or font binaries are bundled in this skill.
Check authorization before downloading resources. Use documented telemetry/update
controls when available; an unknown environment variable is not proof of no network.

For deterministic composition, set dimensions/fps/duration and a readable hold;
drive state by absolute time, not wall-clock/randomness/unbounded loops; wait for
fonts; reproduce the same frame when seeking in either direction. Separate
conflicting transforms across containers as needed. Inspect actual layout and
readability, not merely a successful lint result.

After the runtime's current documented check/render commands, review the clip
with `qa_export.py` and playback. Bound parallelism. A silent insert needs no
audio. Import into Vids and verify geometry, playback range, separate scene duration
and neighboring cuts; a clean local render does not prove the final assembly.
