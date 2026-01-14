#!/bin/bash

# Convert PNG logo to ICNS format for macOS
# This script requires ImageMagick or sips (built-in on macOS)

INPUT_PNG="public/pulsar_viewer_logo.png"
OUTPUT_ICNS="public/icon.icns"

if [ ! -f "$INPUT_PNG" ]; then
    echo "Error: $INPUT_PNG not found"
    exit 1
fi

# Check if sips is available (macOS built-in)
if command -v sips &> /dev/null; then
    echo "Converting PNG to ICNS using sips..."
    
    # Create temp directory for icon set
    TEMP_ICONSET=$(mktemp -d)/PulsarViewer.iconset
    mkdir -p "$TEMP_ICONSET"
    
    # Create all required sizes
    for size in 16 32 64 128 256 512 1024; do
        sips -z $size $size "$INPUT_PNG" --out "$TEMP_ICONSET/icon_${size}x${size}.png" > /dev/null
        if [ $size -le 512 ]; then
            sips -z $((size * 2)) $((size * 2)) "$INPUT_PNG" --out "$TEMP_ICONSET/icon_${size}x${size}@2x.png" > /dev/null
        fi
    done
    
    # Convert iconset to icns
    iconutil -c icns "$TEMP_ICONSET" -o "$OUTPUT_ICNS"
    rm -rf "$TEMP_ICONSET"
    
    echo "Successfully created $OUTPUT_ICNS"
elif command -v convert &> /dev/null; then
    echo "Converting PNG to ICNS using ImageMagick..."
    convert "$INPUT_PNG" -define icon:auto-resize=256,128,96,64,48,32,16 "$OUTPUT_ICNS"
    echo "Successfully created $OUTPUT_ICNS"
else
    echo "Error: sips or ImageMagick not found"
    echo "Please install ImageMagick or use macOS with sips built-in"
    exit 1
fi
