import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface Segment {
  id: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  title: string;
  description: string;
  characters: string[];
  sceneTags: string[];
  keyDialogue: string;
  confidence: number;
}

interface EditorState {
  segments: Segment[];
  selectedSegmentId: string | null;
  currentTime: number;
}

const initialSegments: Segment[] = [
  {
    id: 'seg-1',
    startTime: 0,
    endTime: 300, // 5 mins
    title: 'Intro / Teaser',
    description: 'Opening scene setting the mood.',
    characters: ['Picard', 'Riker'],
    sceneTags: ['intro', 'tense'],
    keyDialogue: 'Space, the final frontier...',
    confidence: 0.95,
  },
  {
    id: 'seg-2',
    startTime: 300,
    endTime: 900, // 15 mins (10 min duration)
    title: 'Ten Forward Meeting',
    description: 'Crew gathers to discuss the anomaly.',
    characters: ['Troi', 'Data', 'Guinan'],
    sceneTags: ['dialogue', 'plot'],
    keyDialogue: 'I sense a disturbance.',
    confidence: 0.88,
  },
  {
    id: 'seg-3',
    startTime: 2040, // 34:00
    endTime: 2115, // 35:15 (1:15 duration)
    title: 'Central Perk Finale',
    description: 'The friends gather at Central Perk for what might be their last coffee together.',
    characters: ['All Six Friends'],
    sceneTags: ['friendship', 'nostalgia', 'finale', 'emotional'],
    keyDialogue: '"So this is it. Ten years of coffee, ten years of friendship. I guess some things really do last forever, even when everything else changes."',
    confidence: 0.88,
  },
];

const initialState: EditorState = {
  segments: initialSegments,
  selectedSegmentId: null,
  currentTime: 0,
};

export const editorSlice = createSlice({
  name: 'editor',
  initialState,
  reducers: {
    setSegments: (state, action: PayloadAction<Segment[]>) => {
      state.segments = action.payload;
    },
    selectSegment: (state, action: PayloadAction<string | null>) => {
      state.selectedSegmentId = action.payload;
    },
    updateSegmentTime: (state, action: PayloadAction<{ id: string; start: number; end: number }>) => {
      const segment = state.segments.find((s) => s.id === action.payload.id);
      if (segment) {
        segment.startTime = action.payload.start;
        segment.endTime = action.payload.end;
      }
    },
    splitSegment: (state, action: PayloadAction<string>) => {
        const index = state.segments.findIndex(s => s.id === action.payload);
        if (index !== -1) {
            const segment = state.segments[index];
            const midPoint = segment.startTime + (segment.endTime - segment.startTime) / 2;
            
            const newSegment1 = { ...segment, endTime: midPoint, id: segment.id + '-a', title: segment.title + ' (Part 1)' };
            const newSegment2 = { ...segment, startTime: midPoint, id: segment.id + '-b', title: segment.title + ' (Part 2)' };
            
            // Replace original with two new parts
            state.segments.splice(index, 1, newSegment1, newSegment2);
        }
    },
    setCurrentTime: (state, action: PayloadAction<number>) => {
        state.currentTime = action.payload;
    }
  },
});

export const { setSegments, selectSegment, updateSegmentTime, splitSegment, setCurrentTime } = editorSlice.actions;
export default editorSlice.reducer;

