#!/bin/bash
set -e

echo "Packaging render Lambda with node_modules..."

# Clean
rm -rf render-package
rm -f render-lambda.zip

# Create package directory
mkdir -p render-package

# Copy handler files
cp dist/renderVideo.js render-package/
cp dist/getRenderStatus.js render-package/

# Copy only Remotion dependencies
mkdir -p render-package/node_modules
cp -r node_modules/@remotion render-package/node_modules/

# Create zip
cd render-package
zip -r ../render-lambda.zip .
cd ..

echo "Created render-lambda.zip ($(du -h render-lambda.zip | cut -f1))"
