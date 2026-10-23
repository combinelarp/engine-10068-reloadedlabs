package com.sandboxol.blockmango;

import java.io.FileInputStream;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.media.MediaPlayer;
import android.util.Log;

import java.util.Timer;
import java.util.TimerTask;
import java.util.Random;

public class EchoesMusic {
    // ===========================================================
    // Constants
    // ===========================================================
    private static final String TAG = EchoesMusic.class.getSimpleName();

    // ===========================================================
    // Fields
    // ===========================================================
    private final Context mContext;
    private MediaPlayer mBackgroundMediaPlayer;
    private float mLeftVolume;
    private float mRightVolume;
    private boolean mPaused;
    private String mCurrentPath;

    // ===========================================================
    // Constructors
    // ===========================================================

    public EchoesMusic(final Context pContext) {
        this.mContext = pContext;
        this.initData();
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
    public void preloadBackgroundMusic(final String pPath) {
        try {
            if ((this.mCurrentPath == null) || (!this.mCurrentPath.equals(pPath))) {
                // release old resource and create a new one
                if (this.mBackgroundMediaPlayer != null) {
                    this.mBackgroundMediaPlayer.release();
                }

                this.mBackgroundMediaPlayer = this.createMediaplayer(pPath);

                // record the path
                this.mCurrentPath = pPath;
            }
        } catch (Exception e) {
            Log.e(EchoesMusic.TAG, "preloadBackgroundMusic error", e);
        }
    }

    public void playBackgroundMusic(final String pPath, final boolean isLoop, final float minInterval, final float maxInterval) {
        try {
            if (this.mCurrentPath == null) {
                // it is the first time to play background music or end() was called
                this.mBackgroundMediaPlayer = this.createMediaplayer(pPath);
                this.mCurrentPath = pPath;
            } else {
                if (!this.mCurrentPath.equals(pPath)) {
                    // play new background music
                    // release old resource and create a new one
                    if (this.mBackgroundMediaPlayer != null) {
                        this.mBackgroundMediaPlayer.release();
                    }
                    this.mBackgroundMediaPlayer = this.createMediaplayer(pPath);

                    // record the path
                    this.mCurrentPath = pPath;
                }
            }
        } catch (Exception e) {
            Log.e(EchoesMusic.TAG, "playBackgroundMusic error", e);
            return;
        }

        if (this.mBackgroundMediaPlayer == null) {
            Log.e(EchoesMusic.TAG, "playBackgroundMusic: background media player is null");
        } else {
            try {
                if (mBackgroundMediaPlayer.isPlaying()) {
                    mBackgroundMediaPlayer.stop();
                    mBackgroundMediaPlayer.prepare();
                }
            } catch (final Exception e) {
                Log.e(EchoesMusic.TAG, "playBackgroundMusic: prepare error");
            }

            this.mBackgroundMediaPlayer.setLooping(false);
            try {
                //this.mBackgroundMediaPlayer.prepare();
                this.mBackgroundMediaPlayer.seekTo(0);
                this.mBackgroundMediaPlayer.start();

                if(isLoop) {
                    MediaPlayer.OnCompletionListener listener = new MediaPlayer.OnCompletionListener(){
                        @Override
                        public void onCompletion(final MediaPlayer mediaPlayer) {
                            Timer timer = new Timer();
                            TimerTask task = new TimerTask() {
                                @Override
                                public void run() {
                                    try {
                                        if(mediaPlayer != null && !mediaPlayer.isPlaying())
                                            mediaPlayer.start();
                                    } catch (Exception e) {
                                        e.printStackTrace();
                                    }
                                }
                            };

                            double interval = minInterval + (maxInterval - minInterval) * Math.random();
                            timer.schedule(task, (int)(interval * 1000));
                        }
                    };

                    this.mBackgroundMediaPlayer.setOnCompletionListener(listener);
                }

                this.mPaused = false;
            } catch (final Exception e) {
                Log.e(EchoesMusic.TAG, "playBackgroundMusic: error state");
            }
        }
    }

    public void stopBackgroundMusic() {
        try {
            if (this.mBackgroundMediaPlayer != null) {
                this.mBackgroundMediaPlayer.stop();

                // should set the state, if not, the following sequence will be error
                // play -> pause -> stop -> resume
                this.mPaused = false;
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void pauseBackgroundMusic() {
        try {
            if (this.mBackgroundMediaPlayer != null && this.mBackgroundMediaPlayer.isPlaying()) {
                this.mBackgroundMediaPlayer.pause();
                this.mPaused = true;
            }
        } catch (Exception e) {
            Log.e(EchoesMusic.TAG, "pauseBackgroundMusic error", e);
        }
    }

    public void resumeBackgroundMusic() {
        try {
            if (this.mBackgroundMediaPlayer != null && this.mPaused) {
                this.mBackgroundMediaPlayer.start();
                this.mPaused = false;
            }
        } catch (Exception e) {
            Log.e(EchoesMusic.TAG, "resumeBackgroundMusic error", e);
        }
    }

    public void rewindBackgroundMusic() {
        if (this.mBackgroundMediaPlayer != null) {
            try {
                this.mBackgroundMediaPlayer.stop();
                this.mBackgroundMediaPlayer.prepare();
                this.mBackgroundMediaPlayer.seekTo(0);
                this.mBackgroundMediaPlayer.start();

                this.mPaused = false;
            } catch (final Exception e) {
                Log.e(EchoesMusic.TAG, "rewindBackgroundMusic: error state");
            }
        }
    }

    public boolean isBackgroundMusicPlaying() {
        try {
            return this.mBackgroundMediaPlayer != null && this.mBackgroundMediaPlayer.isPlaying();
        } catch (Exception e) {
            Log.e(EchoesMusic.TAG, "isBackgroundMusicPlaying error", e);
            return false;
        }
    }

    public void end() {
        try {
            if (this.mBackgroundMediaPlayer != null) {
                this.mBackgroundMediaPlayer.release();
            }
        } catch (Exception e) {
            Log.e(EchoesMusic.TAG, "end error", e);
        }

        this.initData();
    }

    public float getBackgroundVolume() {
        if (this.mBackgroundMediaPlayer != null) {
            return (this.mLeftVolume + this.mRightVolume) / 2;
        } else {
            return 0.0f;
        }
    }

    public void setBackgroundVolume(float pVolume) {
        if (pVolume < 0.0f) {
            pVolume = 0.0f;
        }

        if (pVolume > 1.0f) {
            pVolume = 1.0f;
        }

        this.mLeftVolume = this.mRightVolume = pVolume;
        try {
            if (this.mBackgroundMediaPlayer != null) {
                this.mBackgroundMediaPlayer.setVolume(this.mLeftVolume, this.mRightVolume);
            }
        } catch (Exception e) {
            Log.e(EchoesMusic.TAG, "setBackgroundVolume error", e);
        }
    }

    private void initData() {
        this.mLeftVolume = 0.5f;
        this.mRightVolume = 0.5f;
        this.mBackgroundMediaPlayer = null;
        this.mPaused = false;
        this.mCurrentPath = null;
    }

    /**
     * create mediaplayer for music
     *
     * @param pPath the pPath relative to assets
     * @return
     */
    private MediaPlayer createMediaplayer(final String pPath) {
        MediaPlayer mediaPlayer = null;

        try {
            mediaPlayer = new MediaPlayer();

            if (pPath.startsWith("/")) {
                final FileInputStream fis = new FileInputStream(pPath);
                mediaPlayer.setDataSource(fis.getFD());
                fis.close();
            } else {
                final AssetFileDescriptor assetFileDescritor = this.mContext.getAssets().openFd(pPath);
                mediaPlayer.setDataSource(assetFileDescritor.getFileDescriptor(), assetFileDescritor.getStartOffset(), assetFileDescritor.getLength());
            }

            mediaPlayer.prepare();

            mediaPlayer.setVolume(this.mLeftVolume, this.mRightVolume);
        } catch (final Exception e) {
            Log.e(EchoesMusic.TAG, "error: " + e.getMessage(), e);
            try {
                if (mediaPlayer != null) {
                    mediaPlayer.release();
                }
            } catch (Exception ignored) {
            }
            mediaPlayer = null;
        }

        return mediaPlayer;
    }

    // ===========================================================
    // Inner and Anonymous Classes
    // ===========================================================
}
