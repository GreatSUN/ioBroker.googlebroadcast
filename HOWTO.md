\# How to setup Google Broadcast for ioBroker



This adapter uses the "Google Assistant API" to send text commands (like "Broadcast to Kitchen Hello") directly to Google, just as if you typed them into your phone.



To make this work, you must create a Google Cloud Project and register this adapter as a device.



\## Step 1: Create a Google Cloud Project

1\. Go to the \[Google Cloud Console](https://console.cloud.google.com/).

2\. Click \*\*Create Project\*\*. Name it `iobroker-broadcast` or similar.

3\. Once created, select the project.



\## Step 2: Enable the API

1\. Open the menu (top left) > \*\*APIs \& Services\*\* > \*\*Library\*\*.

2\. Search for \*\*"Google Assistant API"\*\*.

3\. Click it and click \*\*Enable\*\*.



\## Step 3: Configure Consent Screen

1\. Go to \*\*APIs \& Services\*\* > \*\*OAuth consent screen\*\*.

2\. Select \*\*External\*\* and click Create.

3\. Fill in the required fields:

&nbsp;  - App Name: `ioBroker Broadcast`

&nbsp;  - User support email: (Your email)

&nbsp;  - Developer contact info: (Your email)

4\. Click \*\*Save and Continue\*\* until you reach \*\*Test Users\*\*.

5\. \*\*Important:\*\* Click \*\*Add Users\*\* and add your own Google email address (the one used on your Google Home devices).

6\. Save and finish.



\## Step 4: Create Credentials

1\. Go to \*\*APIs \& Services\*\* > \*\*Credentials\*\*.

2\. Click \*\*Create Credentials\*\* > \*\*OAuth client ID\*\*.

3\. Application type: \*\*Desktop app\*\* (or TV and Limited Input devices).

4\. Name: `ioBroker Adapter`.

5\. Click \*\*Create\*\*.

6\. A popup will appear. Click \*\*Download JSON\*\* (or look for the download icon in the list).

7\. Save this file as `credentials.json` (or open it and copy the content).

8\. \*\*Paste this content into the Adapter Settings "Google Credentials" field.\*\*



\## Step 5: Register Device Model

1\. Go to the \[Actions on Google Console](https://console.actions.google.com/).

2\. Click \*\*New Project\*\* -> Select the Project you created in Step 1.

3\. Skip the wizard if asked (Click "Are you looking for device registration?" at the bottom if visible, or go to \*\*Device Registration\*\* in the menu).

4\. Click \*\*Register Model\*\*.

&nbsp;  - Product Name: `ioBroker`

&nbsp;  - Manufacturer: `Open Source`

&nbsp;  - Device Type: `Light` (or anything generic).

5\. Click \*\*Register Model\*\*.

6\. On the next screen, copy the \*\*Model ID\*\*.

&nbsp;  - e.g., `iobroker-12345`

7\. \*\*Paste this Model ID into the Adapter Settings.\*\*

8\. You can skip the "Download credentials" part here, we already did that in Cloud Console.



\## Step 6: Authenticate in ioBroker

1\. In the ioBroker Adapter Settings, ensure `credentials.json` is pasted.

2\. Click \*\*Get Auth URL\*\*.

3\. A new tab opens. Login with your Test User account.

4\. \*\*Grant permissions\*\* (you might see a "Google hasn't verified this app" warning -> Click Advanced -> Proceed/Go to... unsafe).

5\. Copy the code (usually starts with `4/0...`).

6\. Paste it into the Adapter Settings \*\*Step B\*\* box.

7\. Click \*\*Generate Tokens\*\*.

8\. Save and Close the adapter settings.



The adapter will now restart, scan your network for devices, and you are ready to broadcast!

