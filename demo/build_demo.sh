#!/bin/bash
# Guardrail Demo Video — Production Script
# Prerequisites: ffmpeg, the recording WebP, and voiceover audio (MP3/WAV)

set -e

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
RECORDING="$DEMO_DIR/recording.webp"
VOICEOVER="$DEMO_DIR/voiceover.mp3"
SUBTITLES="$DEMO_DIR/subtitles.srt"
OUTPUT="$DEMO_DIR/guardrail_demo.mp4"

echo "🛡️ Guardrail Demo Video Builder"
echo ""

# Step 1: Convert WebP recording to MP4
if [ ! -f "$RECORDING" ]; then
    echo "❌ Missing recording.webp"
    echo "   Copy the WebP recording here:"
    echo "   cp path/to/guardrail_final_demo_*.webp $RECORDING"
    exit 1
fi

echo "1️⃣ Converting WebP → MP4..."
ffmpeg -y -i "$RECORDING" -c:v libx264 -pix_fmt yuv420p -r 10 "$DEMO_DIR/video_only.mp4" 2>/dev/null
echo "   ✅ video_only.mp4"

# Step 2: Add voiceover audio
if [ -f "$VOICEOVER" ]; then
    echo "2️⃣ Adding voiceover audio..."
    ffmpeg -y -i "$DEMO_DIR/video_only.mp4" -i "$VOICEOVER" \
        -c:v copy -c:a aac -shortest "$DEMO_DIR/with_audio.mp4" 2>/dev/null
    echo "   ✅ with_audio.mp4"
else
    echo "2️⃣ No voiceover.mp3 found — skipping audio"
    cp "$DEMO_DIR/video_only.mp4" "$DEMO_DIR/with_audio.mp4"
fi

# Step 3: Burn subtitles
if [ -f "$SUBTITLES" ]; then
    echo "3️⃣ Burning subtitles..."
    ffmpeg -y -i "$DEMO_DIR/with_audio.mp4" \
        -vf "subtitles=$SUBTITLES:force_style='FontSize=20,FontName=Inter,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=40'" \
        -c:a copy "$OUTPUT" 2>/dev/null
    echo "   ✅ guardrail_demo.mp4 (with subtitles)"
else
    echo "3️⃣ No subtitles.srt — skipping"
    cp "$DEMO_DIR/with_audio.mp4" "$OUTPUT"
fi

echo ""
echo "🎬 Done! Output: $OUTPUT"
echo ""
echo "📋 Next steps:"
echo "   1. Generate voiceover: paste demo/voiceover.txt into ElevenLabs.io"
echo "   2. Save as demo/voiceover.mp3"
echo "   3. Re-run this script to combine video + audio + subtitles"
