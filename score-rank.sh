#!/bin/bash

# Kill any existing instance of express.cjs
echo "Checking for existing server instances..."
pkill -f "node express.cjs"

while true; do
    echo "Starting Server...."
    node express.cjs
    echo "Server crashed. Restarting..."
    sleep 1
done
#StandardOutput=append:/var/log/express.log
#StandardError=append:/var/log/express.log
