# ioBroker.googlebroadcast

![Logo](admin/googlebroadcast.png)

**Broadcasts text messages via Google Assistant SDK to specific devices or your entire home.**

This adapter allows you to send commands like "Dinner is ready" or "The washing machine is done" directly to your Google Home / Nest speakers, broadcasting them as a voice announcement.

## Prerequisites
1.  **Google Cloud Project**: You need a project with the "Google Assistant API" enabled.
2.  **Credentials**: An OAuth 2.0 Client ID (JSON file) and an API Key.
3.  **Python**: Required once for the initial device registration script.

---

## Setup Guide

### Step 1: Google Cloud Setup
1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  **Create a New Project** (e.g., \`iobroker-broadcast\`).
3.  **Enable API**:
    * Go to **APIs & Services > Library**.
    * Search for **"Google Assistant API"** and click **Enable**.
4.  **Configure OAuth Screen**:
    * Go to **APIs & Services > OAuth consent screen**.
    * Select **External**.
    * Fill in required fields (App Name, Email).
    * **Important**: Under **Test Users**, add your own Google Email address.
    * Save and Continue.
5.  **Create Credentials (JSON)**:
    * Go to **APIs & Services > Credentials**.
    * Click **+ Create Credentials > OAuth client ID**.
    * Application Type: **Desktop App** (or TV & Limited Input).
    * Name: \`ioBroker Adapter\`.
    * Click Create and **Download the JSON file**. Save it as \`credentials.json\`.
6.  **Create API Key**:
    * Still in **Credentials**, click **+ Create Credentials > API Key**.
    * Copy the key (starts with \`AIza...\`).

### Step 2: Register Device Model
*Google has removed the web UI for this, so you must use the included script.*

1.  **Open your ioBroker terminal.**
2.  **Install Python dependencies:**
    \`\`\`bash
    sudo apt-get update && sudo apt-get install python3-pip python3-venv
    python3 -m venv env
    source env/bin/activate
    pip install google-auth-oauthlib google-api-python-client requests urllib3
    \`\`\`
3.  **Upload your \`credentials.json\`** to this directory.
4.  **Run the registration script:**
    *(Replace parameters with your actual data)*
    \`\`\`bash
    # Syntax: python3 script.py [PROJECT_ID] [API_KEY] --name [NAME]
    python3 node_modules/iobroker.googlebroadcast/admin/register_device_model.py iobroker-broadcast-123 AIzaSyDxxxxxxxxxxxx --name iobroker
    \`\`\`
5.  Follow the link to authorize.
6.  **Copy the generated Model ID** (e.g., \`iobroker-model\`) for the next step.

### Step 3: Configure Adapter
1.  Open the Adapter Settings in ioBroker.
2.  **Google Credentials**: Paste the content of your \`credentials.json\`.
3.  **Device Model ID**: Paste the Model ID from Step 2.
4.  **Authentication**:
    * Click **"1. Prepare Login Link"**.
    * Click the generated blue link to open Google Login.
    * Authorize the app (you may need to click "Advanced > Go to... (unsafe)").
    * Copy the **Auth Code** (starts with \`4/0...\`).
    * Paste the code into the **"Step B"** box.
5.  **Click Save and Close.**

The adapter will restart, generate tokens automatically, and turn green.

---

## Usage
* **Broadcast All**: Write text to \`googlebroadcast.0.broadcast_all\`.
* **Specific Device**: Write text to \`googlebroadcast.0.devices.[name].broadcast\`.

## License
MIT