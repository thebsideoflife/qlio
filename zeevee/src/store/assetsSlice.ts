import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface Asset {
  id: string;
  title: string;
  thumbnail: string;
  status: 'processing' | 'completed' | 'failed';
  format: string;
  size: string;
  segmentCount: number;
  views: number;
  createdAt: string;
  // Processing details (optional, for processing items)
  processing?: {
    stage: 'upload' | 'transcription' | 'clip_selection' | 'reframing' | 'captions' | 'delivery';
    progress: number; // 0-100
    startedAt: string;
    eta: string;
    stages: {
        upload: number;
        transcription: number;
        clip_selection: number;
        reframing: number;
        captions: number;
        delivery: number;
    }
  }
}

interface AssetsState {
  items: Asset[];
}

const initialState: AssetsState = {
  items: [
    {
      id: '1',
      title: 'Star Trek: The Next Generation S07E25',
      thumbnail: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&auto=format&fit=crop&q=60',
      status: 'completed',
      format: '4K H.264',
      size: '2.4 GB',
      segmentCount: 8,
      views: 12500,
      createdAt: '2023-10-26T10:00:00Z',
    },
    {
      id: '2',
      title: 'The X-Files S03E08 "Oubliette"',
      thumbnail: 'https://images.unsplash.com/photo-1618331835717-801e976710b2?w=800&auto=format&fit=crop&q=60',
      status: 'processing',
      format: '1080p H.265',
      size: '1.8 GB',
      segmentCount: 6,
      views: 0,
      createdAt: '2023-11-15T14:30:00Z',
      processing: {
        stage: 'clip_selection',
        progress: 65,
        startedAt: '2023-11-15T14:30:00Z',
        eta: '2023-11-15T15:15:00Z',
        stages: {
            upload: 100,
            transcription: 100,
            clip_selection: 65,
            reframing: 0,
            captions: 0,
            delivery: 0
        }
      }
    },
    {
      id: '3',
      title: 'Breaking Bad S05E14 "Ozymandias"',
      thumbnail: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=800&auto=format&fit=crop&q=60',
      status: 'completed',
      format: '4K H.265',
      size: '3.1 GB',
      segmentCount: 12,
      views: 45200,
      createdAt: '2023-11-10T09:20:00Z',
    },
    {
      id: '4',
      title: 'The Sopranos S06E21 "Made in America"',
      thumbnail: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?w=800&auto=format&fit=crop&q=60',
      status: 'processing',
      format: '1080p H.264',
      size: '2.0 GB',
      segmentCount: 0,
      views: 0,
      createdAt: '2023-11-20T11:45:00Z',
      processing: {
        stage: 'transcription',
        progress: 35,
        startedAt: '2023-11-20T11:45:00Z',
        eta: '2023-11-20T12:30:00Z',
        stages: {
            upload: 100,
            transcription: 35,
            clip_selection: 0,
            reframing: 0,
            captions: 0,
            delivery: 0
        }
      }
    },
  ],
};

export const assetsSlice = createSlice({
  name: 'assets',
  initialState,
  reducers: {
    addAsset: (state, action: PayloadAction<Asset>) => {
      state.items.unshift(action.payload);
    },
    updateAssetStatus: (state, action: PayloadAction<{ id: string; status: 'processing' | 'completed' | 'failed' }>) => {
      const asset = state.items.find((a) => a.id === action.payload.id);
      if (asset) {
        asset.status = action.payload.status;
      }
    },
  },
});

export const { addAsset, updateAssetStatus } = assetsSlice.actions;
export default assetsSlice.reducer;
