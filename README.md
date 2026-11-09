# NVR Storage for Scrypted

Saves camera **clips** and **snapshots** to a USB or network drive, Dropbox
and/or Google Drive. It works on its own (record clips on motion) and together
with the **AI Vision Alerts** plugin, which can decide what is worth saving.

Single TypeScript file (`src/main.ts`), no other Scrypted plugins required.
This is a motion/event recorder, not continuous 24/7 recording.

## How it works

Each camera gets an **NVR Storage** settings group with a clip mode:

| Mode | Behavior |
|---|---|
| Off | Nothing is recorded. |
| Keep only clips the AI asks for | On every motion event the plugin records a clip into a temporary staging folder. If AI Vision Alerts asks for it within the wait window (default 90 s after the clip ends), the clip is stored. Otherwise it is deleted. The clip starts at the motion, not after the AI finishes. |
| Keep every motion clip | Every motion clip is stored. |

Stored files go to every enabled destination as
`<camera>/<date>/<time>_<clip|snapshot>[_severity].(mp4|jpg|json)`. Each clip
also gets a thumbnail, and each file a `.json` sidecar with the AI's summary
and severity.

Clips are recorded with ffmpeg stream-copy (no video re-encoding, low CPU).
Audio is converted to AAC.

## Working with AI Vision Alerts

This plugin implements Scrypted's standard **Notifier** interface, so no extra
setup is needed beyond picking it:

1. Install both plugins.
2. On a camera, open **AI Vision Alerts** and add **NVR Storage** under
   "Also send to Scrypted notifiers".
3. Set **Save evidence** to Snapshot, Clip, Snapshot + clip, or
   **Let the AI decide** (and edit the evidence rules in plain English).
4. On the same camera, open **NVR Storage** and set the clip mode to
   "Keep only clips the AI asks for".

The AI plugin only sends requests when it raises an alert, so evidence is
saved for alerts, not for every motion event.

## Destinations

### Local, USB or network drive

Set **Drive mount path** to where the drive appears inside the Scrypted add-on
(for example `/data/usb`). Press **Diagnose storage** to see which folders the
add-on can reach, whether they are writable, and the free space.

**Drive marker (important).** If a USB drive disconnects, Home Assistant can
leave an empty folder at the same path, and recordings would silently fill the
internal disk. With "Require drive marker" on, the plugin refuses to write
unless a marker file exists on the real drive. While the drive is mounted,
press **Create drive marker** once. The button refuses if the path is not a
separate mounted drive. Retention never deletes anything while the marker is
missing.

**Retention.** Delete files older than N days and/or keep the folder under a
maximum size (oldest first). Only files inside `<mount>/<folder>` are touched.

### Dropbox (one-time setup)

1. Go to dropbox.com/developers/apps, create an app with **Scoped access**.
2. On the Permissions tab enable `files.content.write`, then submit.
3. Note the **App key** and **App secret** (Settings tab).
4. Open this URL in a browser (replace `APP_KEY`), allow access, copy the code:
   `https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code`
5. Exchange the code for a refresh token (PowerShell or any shell with curl):
   ```
   curl.exe https://api.dropbox.com/oauth2/token -d code=CODE -d grant_type=authorization_code -u APP_KEY:APP_SECRET
   ```
6. Paste app key, app secret and the `refresh_token` from the reply into the plugin.

Files over about 140 MB are skipped (single-request upload limit); at the
default 30-second clip length this should not occur.

### Google Drive (one-time setup)

1. In Google Cloud Console, create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen. **Publish it to "In production"**: apps
   left in "Testing" have refresh tokens that expire after 7 days.
3. Create an OAuth client ID (type Web application) with the redirect URI
   `https://developers.google.com/oauthplayground`.
4. In the OAuth 2.0 Playground, click the gear, tick "Use your own OAuth
   credentials", enter the client ID and secret, authorize the scope
   `https://www.googleapis.com/auth/drive.file`, and exchange the code. Copy
   the refresh token.
5. Paste client ID, client secret and refresh token into the plugin.

Leave **Drive folder ID** blank. With the `drive.file` scope the plugin can only
see files it created, so it creates and uses its own "Scrypted NVR" folder.
Drive uploads are flat (the camera and date are in the file name).

Cloud destinations have no automatic cleanup. Manage that in Dropbox or Drive.

## Getting a USB drive into the Scrypted add-on (Home Assistant OS)

Home Assistant OS does not hand USB drives to add-ons by default. Two options:

**Option A: mount the drive inside the Scrypted add-on's data folder.**
This is the approach used in a community guide for Scrypted's own NVR
(cmsj.net, "Mounting a separate partition for Scrypted NVR in Home Assistant OS").

1. Format the drive as **ext4** with the label `NVR` (do this on a Linux
   machine or live USB; HAOS support for NTFS/exFAT is unreliable).
2. Find your add-on's slug: Settings > Add-ons > Scrypted, and look at the
   page URL. It looks like `09e60fb6_scrypted`.
3. Format a small USB stick as FAT32 labeled `CONFIG`, create a folder named
   `udev` on it, and put a file `80-mount-scrypted-nvr.rules` inside with
   (replace `SLUG`):
   ```
   KERNEL!="sd[a-z][0-9]", GOTO="abort_rule"
   ENV{ID_PATH}!="*-usb-*", GOTO="abort_rule"
   IMPORT{program}="/usr/sbin/blkid -o udev -p %N"
   ENV{ID_FS_USAGE}!="filesystem", GOTO="abort_rule"
   ENV{ID_FS_LABEL}!="NVR", GOTO="abort_rule"
   ENV{mount_point}="/mnt/data/supervisor/addons/data/SLUG/usb"
   ACTION=="add", RUN{program}+="/usr/bin/mkdir -p %E{mount_point}", RUN{program}+="/usr/bin/systemd-mount --no-block --automount=no --collect $devnode %E{mount_point}"
   ACTION=="remove", RUN{program}+="/usr/bin/systemd-umount %E{mount_point}"
   LABEL="abort_rule"
   ```
4. Plug the CONFIG stick into the Home Assistant machine, reboot, then plug in
   the NVR drive (or reboot with it attached).
5. In the plugin set **Drive mount path** to `/data/usb`, press **Diagnose
   storage**, then **Create drive marker**, then **Write test file to all
   destinations**.

This rule is adapted from community guides and I could not test it on real
hardware. Check it against the guides if it does not mount. One risk to watch:
a drive mounted inside the add-on's data folder might be included when Home
Assistant backs up the Scrypted add-on. If backups become huge or slow, exclude
the Scrypted add-on from backups.

**Option B: use `/media`.** A drive mounted under `/mnt/data/supervisor/media/`
(a popular udev rule for this exists) or a network share added under Settings >
System > Storage appears at `/media/<name>`, but only if the Scrypted add-on
maps the `media` folder. Press **Diagnose storage** to see whether `/media`
exists. If it does, set the mount path to `/media/<name>`.

## Develop and deploy

Same as the AI Vision Alerts plugin: `npm install`, open in VS Code, set
`scrypted.debugHost` in `.vscode/settings.json`, press Launch; or
`npx scrypted login <ip>` then `npm run scrypted-deploy <ip>`.

## Limitations

- Clips only start when motion starts; there is no pre-roll buffer yet.
- If a second motion event happens before the AI answers the first, the AI's
  request is matched to the newest clip for that camera.
- Failed uploads are retried 3 times, then kept in staging for 24 hours and
  logged, but not retried automatically after that.
- Local network shares need to be mounted by the host OS; the plugin does not
  speak SMB or NFS itself.
