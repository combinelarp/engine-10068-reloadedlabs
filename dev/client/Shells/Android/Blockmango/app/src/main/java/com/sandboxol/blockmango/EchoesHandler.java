package com.sandboxol.blockmango;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Message;
import android.util.Log;
import android.view.WindowManager;

@SuppressLint("DefaultLocale")
public class EchoesHandler extends Handler {
    // ===========================================================
    // Constants
    // ===========================================================
    public final static int HANDLER_SHOW_DIALOG = 1;
    public final static int HANDLER_SHOW_EDITBOX_DIALOG = 2;
    public final static int HANDLER_UPDATE_COPY = 3;
    public final static int HANDLER_COPY_COMPLETE = 4;
    public final static int HANDLER_INIT_OK = 5;
    public final static int HANDLER_GL_INIT_OK = 6;
    public final static int HANDLER_UPDATE_DOWNLOAD = 7;
    public final static int HANDLER_POPUP_CONFIRM_UPDATE_APP = 8;
    public final static int HANDLER_POPUP_CONFIRM_UPDATE_RES = 9;
    public final static int HANDLER_CONFIRM_UPDATE_RES = 10;
    public final static int HANDLER_UPDATE_VERSION_TEXT = 11;
    public final static int HANDLER_DOWNLOAD_NEW_APP = 12;
    public final static int HANDLER_EXIT_GAME = 13;
    public final static int HANDLER_USER_PROP = 14;
    public final static int HANDLER_RESET_START = 15;
    public final static int HANDLER_SHOW_SMALL_EDITBOX_DIALOG = 16;

    // ===========================================================
    // Fields
    // ===========================================================
    private WeakReference<EchoesActivity> mActivity;

    // ===========================================================
    // Constructors
    // ===========================================================
    public EchoesHandler(EchoesActivity activity) {
        this.mActivity = new WeakReference<EchoesActivity>(activity);
    }

    // ===========================================================
    // Getter & Setter
    // ===========================================================

    // ===========================================================
    // Methods for/from SuperClass/Interfaces
    // ===========================================================

    // ===========================================================
    // Methods
    // ===========================================================

    private EchoesActivity getActivity() {
        EchoesActivity activity = this.mActivity.get();
        if (activity == null || activity.isFinishing()) {
            return null;
        }
        if (Build.VERSION.SDK_INT >= 17 && activity.isDestroyed()) {
            return null;
        }
        return activity;
    }

    public void handleMessage(Message msg) {
        switch (msg.what) {
            case EchoesHandler.HANDLER_DOWNLOAD_NEW_APP: {
                EchoesActivity activity = getActivity();
                downloadAppMessage msgObj = (downloadAppMessage) msg.obj;
                if (activity == null || msgObj == null) {
                    break;
                }

                try {
                    Uri uri = Uri.parse(msgObj.url);
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    activity.startActivity(intent);
                } catch (Throwable t) {
                    Log.e("EchoesHandler", "Failed to open download url", t);
                }
            }
            break;

            case EchoesHandler.HANDLER_UPDATE_VERSION_TEXT: {
                EchoesActivity activity = getActivity();
                if (activity != null && EchoesRenderer.areLibrariesLoaded()) {
                    activity.SetVersionText(EchoesRenderer.nativeGetLocalVersion(), EchoesRenderer.nativeGetServerVersion());
                }
            }
            break;

            case EchoesHandler.HANDLER_POPUP_CONFIRM_UPDATE_APP: {
                popupUpdateAppConfirm(msg);
            }
            break;

            case EchoesHandler.HANDLER_POPUP_CONFIRM_UPDATE_RES: {
                popupUpdateResConfirm(msg);
            }
            break;

            case EchoesHandler.HANDLER_SHOW_DIALOG:
                showDialog(msg);
                break;

            case EchoesHandler.HANDLER_SHOW_EDITBOX_DIALOG:
                showEditBoxDialog(msg);
                break;

            case EchoesHandler.HANDLER_SHOW_SMALL_EDITBOX_DIALOG:
                showSmallEditBoxDialog(msg);
                break;

            case EchoesHandler.HANDLER_UPDATE_COPY:
                updateCopyView(msg);
                break;

            case EchoesHandler.HANDLER_UPDATE_DOWNLOAD:
                updateDownloadView(msg);
                break;

            case EchoesHandler.HANDLER_COPY_COMPLETE:
                copyComplete(msg);
                break;

            case EchoesHandler.HANDLER_INIT_OK: {
                EchoesActivity activity = getActivity();
                if (activity != null) {
                    activity.RemoveLoadingView();
                }
            }
            break;

            case EchoesHandler.HANDLER_GL_INIT_OK:
                OnGLInitOK();
                break;

            case EchoesHandler.HANDLER_EXIT_GAME:
                exitGame();
                break;

            case EchoesHandler.HANDLER_USER_PROP:
                String propId = (String) msg.obj;
                useProp(propId);
                break;

            case EchoesHandler.HANDLER_RESET_START:{
                EchoesActivity activity = getActivity();
                if (activity != null) {
                    activity.addLoadingView();
                }
            }
        }
    }

    private void OnGLInitOK() {
        EchoesActivity theActivity = getActivity();
        if (theActivity != null) {
            theActivity.DoMainInit();
        }
    }

    private void showDialog(Message msg) {
        EchoesActivity theActivity = getActivity();
        DialogMessage dialogMessage = (DialogMessage) msg.obj;
        if (theActivity == null || dialogMessage == null) {
            return;
        }
        try {
            new AlertDialog.Builder(theActivity)
                    .setTitle(dialogMessage.titile)
                    .setMessage(dialogMessage.message)
                    .setPositiveButton("Ok",
                            new DialogInterface.OnClickListener() {

                                @Override
                                public void onClick(DialogInterface dialog, int which) {
                                    // TODO Auto-generated method stub

                                }
                            }).create().show();
        } catch (WindowManager.BadTokenException e) {
            Log.e("EchoesHandler", "Unable to show dialog", e);
        } catch (IllegalStateException e) {
            Log.e("EchoesHandler", "Unable to show dialog", e);
        }
    }

    private void showEditBoxDialog(Message msg) {
        EchoesActivity theActivity = getActivity();
        EditBoxMessage editBoxMessage = (EditBoxMessage) msg.obj;
        if (theActivity == null || editBoxMessage == null) {
            return;
        }
        try {
            new EchoesEditBoxDialog(theActivity,
                    editBoxMessage.title,
                    editBoxMessage.content,
                    editBoxMessage.inputMode,
                    editBoxMessage.inputFlag,
                    editBoxMessage.returnType,
                    editBoxMessage.maxLength).show();
        } catch (WindowManager.BadTokenException e) {
            Log.e("EchoesHandler", "Unable to show edit box", e);
        } catch (IllegalStateException e) {
            Log.e("EchoesHandler", "Unable to show edit box", e);
        }
    }

    private void showSmallEditBoxDialog(Message msg) {
        EchoesActivity theActivity = getActivity();
        EditBoxMessage editBoxMessage = (EditBoxMessage) msg.obj;
        if (theActivity == null || editBoxMessage == null) {
            return;
        }
        try {
            new EchoesEditBoxDialog(theActivity,
                    editBoxMessage.title,
                    editBoxMessage.content,
                    editBoxMessage.inputMode,
                    editBoxMessage.inputFlag,
                    editBoxMessage.returnType,
                    editBoxMessage.maxLength).show();
        } catch (WindowManager.BadTokenException e) {
            Log.e("EchoesHandler", "Unable to show edit box", e);
        } catch (IllegalStateException e) {
            Log.e("EchoesHandler", "Unable to show edit box", e);
        }
    }

    private void updateCopyView(Message msg) {
        EchoesActivity theActivity = getActivity();
        CopyMessage copyMessage = (CopyMessage) msg.obj;
        if (theActivity == null || copyMessage == null) {
            return;
        }
        int nCopyCount = copyMessage.mnCopyCount;
        int nWholeCount = copyMessage.mnWholeCount;

        float fPercent = nWholeCount <= 0 ? 0.0f : nCopyCount * 100.0f / nWholeCount;

        String temp = theActivity.getString(R.string.prepare_text);
        String strText = String.format("%s:%.2f%%", temp, fPercent);

        theActivity.SetUpdateTips(strText);
    }

    private void updateDownloadView(Message msg) {
        EchoesActivity theActivity = getActivity();
        UpdateDownloadMessage downloadMessage = (UpdateDownloadMessage) msg.obj;
        if (theActivity == null || downloadMessage == null) {
            return;
        }
        int nCopyCount = downloadMessage.mnDownloadCount;
        int nWholeCount = downloadMessage.mnWholeCount;
        int nState = downloadMessage.downloadState;

        float fPercent = nWholeCount <= 0 ? 0.0f : nCopyCount * 100.0f / nWholeCount;

        String temp;

        String strText;

        if (nState == 0) {
            temp = theActivity.getString(R.string.download_text);

            float totalSize = EchoesRenderer.areLibrariesLoaded() ? EchoesRenderer.nativeGetTotalDownloadSize() * 0.001f : 0.0f;
            float currentDownloadSize = EchoesRenderer.areLibrariesLoaded() ? EchoesRenderer.nativeGetCurrentDownloadSize() * 0.001f : 0.0f;

            strText = String.format("%s:%.3fkb/%.3fkb\n%.2f%%", temp, currentDownloadSize, totalSize, fPercent);
        } else {
            temp = theActivity.getString(R.string.update_text);
            strText = String.format("%s:%.2f%%", temp, fPercent);
        }

        theActivity.SetUpdateTips(strText);
    }


    private void copyComplete(Message msg) {
        EchoesActivity theActivity = getActivity();
        EchoesGLSurfaceView surfaceView = EchoesGLSurfaceView.getInstance();
        if (theActivity == null || surfaceView == null) {
            return;
        }
        EchoesRenderer renderer = surfaceView.getRenderer();
        if (renderer == null) {
            return;
        }
        surfaceView.initGame(theActivity.getRootPath(), theActivity.getConfigPath(), theActivity.getMapPath(), renderer.getScreenWidth(), renderer.getScreenHeight());
    }

    private void exitGame(){
        EchoesGLSurfaceView surfaceView = EchoesGLSurfaceView.getInstance();
        if (surfaceView != null) {
            surfaceView.exitGame();
        }
    }

    private void useProp(String propId) {
        EchoesGLSurfaceView surfaceView = EchoesGLSurfaceView.getInstance();
        if (surfaceView != null) {
            surfaceView.useProp(propId);
        }
    }

    private void popupUpdateResConfirm(Message msg) {
        final EchoesActivity theActivity = getActivity();
        if (theActivity == null) {
            return;
        }

        int totalSize = EchoesRenderer.areLibrariesLoaded() ? EchoesRenderer.nativeGetTotalDownloadSize() : 0;

        String strTips = String.format("%s:%.3fkb", theActivity.getString(R.string.update_text_tips), totalSize * 0.001f);

        try {
            new AlertDialog.Builder(theActivity)
                    .setTitle(theActivity.getString(R.string.dialog_title))
                    .setMessage(strTips)
                    .setIcon(R.drawable.ic_launcher)
                    .setPositiveButton(theActivity.getString(R.string.dialog_ok_text), new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface dialog, int whichButton) {
                            Message toCopyThread = theActivity.mChildHandler.obtainMessage();
                            toCopyThread.what = HANDLER_CONFIRM_UPDATE_RES;
                            theActivity.mChildHandler.sendMessage(toCopyThread);
                        }
                    })
                    .setNegativeButton(theActivity.getString(R.string.dialog_cancel_text), new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface dialog, int whichButton) {
                            //cancel
                            theActivity.finish();
                        }
                    })
                    .show();
        } catch (WindowManager.BadTokenException e) {
            Log.e("EchoesHandler", "Unable to show update dialog", e);
        } catch (IllegalStateException e) {
            Log.e("EchoesHandler", "Unable to show update dialog", e);
        }
    }

    public String downloadBaseFile(String urlStr) {
        StringBuffer sb = new StringBuffer();
        String line = null;
        BufferedReader reader = null;
        try {
            //创建一个url对象
            URL url = new URL(urlStr);
            //通過url对象，创建一个HttpURLConnection对象（连接）
            HttpURLConnection urlConnection = (HttpURLConnection) url.openConnection();
            //通过HttpURLConnection对象，得到InputStream
            reader = new BufferedReader(new InputStreamReader(urlConnection.getInputStream()));
            //使用io流读取文件
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            try {
                if (reader != null) {
                    reader.close();
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
        return sb.toString();
    }

    class downloadThread extends Thread {
        private EchoesHandler mainHandler;

        public downloadThread() {
        }

        public downloadThread(EchoesHandler handler) {
            this.mainHandler = handler;
        }

        public void run() {
            String contents = downloadBaseFile("http://192.168.1.11:8086/config/mcdownload.cfg");
            System.out.println(contents);

//			Message msg = new Message();
//			msg.what = EchoesHandler.HANDLER_DOWNLOAD_NEW_APP;
//			msg.obj = new downloadAppMessage(contents);
//			mainHandler.sendMessage(msg);

            // 回到主线程
            EchoesActivity activity = getActivity();
            if (activity == null) {
                return;
            }

            try {
                Uri uri = Uri.parse(contents);

                if (uri.getHost() != null && (uri.getScheme().equalsIgnoreCase("http") || uri.getScheme().equalsIgnoreCase("https"))) {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    activity.startActivity(intent);
                } else {
                    activity.finish();
                }
            } catch (Throwable t) {
                Log.e("EchoesHandler", "Failed to handle update url", t);
            }
        }
    }

    private void popupUpdateAppConfirm(Message msg) {
        final EchoesActivity theActivity = getActivity();
        if (theActivity == null) {
            return;
        }

        final EchoesHandler handler = this;

        try {
            new AlertDialog.Builder(theActivity)
                    .setTitle(theActivity.getString(R.string.dialog_title))
                    .setMessage(theActivity.getString(R.string.update_app_tips))
                    .setIcon(R.drawable.ic_launcher)
                    .setPositiveButton(theActivity.getString(R.string.dialog_ok_text), new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface dialog, int whichButton) {
                            new downloadThread(handler).start();
                            //theActivity.finish();
                        }
                    }).show();
        } catch (WindowManager.BadTokenException e) {
            Log.e("EchoesHandler", "Unable to show update dialog", e);
        } catch (IllegalStateException e) {
            Log.e("EchoesHandler", "Unable to show update dialog", e);
        }
    }

    // ===========================================================
    // Inner and Anonymous Classes
    // ===========================================================

    public static class DialogMessage {
        public String titile;
        public String message;

        public DialogMessage(String title, String message) {
            this.titile = title;
            this.message = message;
        }
    }

    public static class downloadAppMessage {
        public String url;

        public downloadAppMessage(String url) {
            this.url = url;
        }
    }

    public static class EditBoxMessage {
        public String title;
        public String content;
        public int inputMode;
        public int inputFlag;
        public int returnType;
        public int maxLength;

        public EditBoxMessage(String title, String content, int inputMode, int inputFlag, int returnType, int maxLength) {
            this.content = content;
            this.title = title;
            this.inputMode = inputMode;
            this.inputFlag = inputFlag;
            this.returnType = returnType;
            this.maxLength = maxLength;
        }
    }

    public static class CopyMessage {
        public int mnCopyCount;
        public int mnWholeCount;

        public CopyMessage(int nCopy, int nWhole) {
            this.mnCopyCount = nCopy;
            this.mnWholeCount = nWhole;
        }
    }

    public static class CopyComplete {

    }

    public static class UpdateDownloadMessage {
        public int mnDownloadCount;
        public int mnWholeCount;
        public int downloadState;

        public UpdateDownloadMessage(int nDownload, int nWhole, int state) {
            this.mnDownloadCount = nDownload;
            this.mnWholeCount = nWhole;
            this.downloadState = state;
        }
    }
}
