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
2.  **Create a New Project** (e.g., `iobroker-broadcast`).
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
    * Name: `ioBroker Adapter`.
    * Click Create and **Download the JSON file**. Save it as `credentials.json`.
6.  **Create API Key**:
    * Still in **Credentials**, click **+ Create Credentials > API Key**.
    * Copy the key (starts with `AIza...`).

### Step 2: Register Device Model
*Google has removed the web UI for this, so you must use the included script located in the `pybin` folder.*

1.  **Navigate to the `pybin` directory:**
    ```bash
    cd node_modules/iobroker.googlebroadcast/pybin
    ```
    *(Or wherever you installed the adapter)*

2.  **Setup Python Environment:**
    *   **Windows:** Double-click `setup_venv.bat` or run it from CMD.
    *   **Linux/Mac:** Run `bash setup_venv.sh`

3.  **Activate the Environment:**
    *   **Windows:** `venv\Scripts\activate`
    *   **Linux/Mac:** `source venv/bin/activate`

4.  **Prepare Credentials:**
    *   Copy your downloaded `credentials.json` (from Step 1) into this `pybin` folder.

5.  **Run the Registration Script:**
    ```bash
    # Syntax: python register_device.py [PROJECT_ID] [API_KEY]
    python register_device.py iobroker-broadcast-123 AIzaSyDxxxxxxxxxxxx
    ```
    *(Replace with your actual Project ID and API Key)*

6.  **Authorize & Copy Model ID:**
    *   Follow the on-screen instructions to authorize.
    *   The script will print the **Model ID** (e.g., `iobroker-model`).
    *   Copy this Model ID for the next step.

### Step 3: Configure Adapter
1.  Open the Adapter Settings in ioBroker.
2.  **Google Credentials**: Paste the content of your `credentials.json`.
3.  **Device Model ID**: Paste the Model ID from Step 2.
4.  **Authentication**:
    * Click **"1. Prepare Login Link"**.
    * Click the generated blue link to open Google Login.
    * Authorize the app (you may need to click "Advanced > Go to... (unsafe)").
    * Copy the **Auth Code** (starts with `4/0...`).
    * Paste the code into the **"Step B"** box.
5.  **Click Save and Close.**

The adapter will restart, generate tokens automatically, and turn green.

---

## Usage
* **Broadcast All**: Write text to `googlebroadcast.0.broadcast_all`.
* **Specific Device**: Write text to `googlebroadcast.0.devices.[name].broadcast`.

## License
MIT