import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useDispatch } from 'react-redux';
import { addAsset } from '@/store/assetsSlice';
import { Tv, Film, Sparkles, Car, Scissors, BookOpen, Flame, Megaphone, Clapperboard, Eye, Languages, ArrowRight, ArrowLeft, Upload, Loader2 } from 'lucide-react';
import { FaTiktok, FaInstagram, FaYoutube } from "react-icons/fa";
import { SiYoutubeshorts } from "react-icons/si";
import { cn } from '@/lib/utils';
import { getUploadUrl, uploadToS3 } from '@/services/api';

interface UploadWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STEPS = [
  { id: 1, title: 'Upload Video', description: 'Select a video file to upload' },
  { id: 2, title: 'Asset Type', description: 'What kind of content do you want to edit?' },
  { id: 3, title: 'Target Platform', description: 'Select your target platform' },
  { id: 4, title: 'Output Format', description: 'Choose content format' },
  { id: 5, title: 'Target Audience', description: 'Define your intended audience' },
  { id: 6, title: 'Business Driver', description: "What's the purpose of this content?" },
  { id: 7, title: 'Output Language', description: "Select the language" },
];

export function UploadWizard({ open, onOpenChange }: UploadWizardProps) {
  const [step, setStep] = useState(1);
  const dispatch = useDispatch();
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [selections, setSelections] = useState<Record<string, any>>({
      type: '',
      platform: '',
      format: '',
      audience: { gender: 'all', age: ['18-24'] },
      driver: '',
      language: 'english'
  });

  const handleNext = async () => {
    if (step === 1 && !file) return; // Require file for step 1

    if (step < STEPS.length) {
      setStep(step + 1);
    } else {
      // Finish & Upload
      await handleUpload();
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setIsUploading(true);
    try {
      // 1. Get Signed URL
      const { uploadUrl, assetId, key } = await getUploadUrl(file.type);
      
      // 2. Upload to S3
      await uploadToS3(uploadUrl, file);

      // 3. Add to Store (Optimistic update or based on success)
      const newAsset = {
        id: assetId,
        title: file.name, // Use file name as title initially
        thumbnail: 'https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=800&auto=format&fit=crop&q=60', // Placeholder
        status: 'processing' as const, // The Lambda will update this to 'indexing' -> 'ready'
        format: '1080p', // Placeholder or detect
        size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        segmentCount: 0,
        views: 0,
        createdAt: new Date().toISOString()
      };

      dispatch(addAsset(newAsset));
      
      // Reset & Close
      onOpenChange(false);
      setStep(1);
      setFile(null);
      setSelections({
          type: '',
          platform: '',
          format: '',
          audience: { gender: 'all', age: ['18-24'] },
          driver: '',
          language: 'english'
      });
    } catch (error) {
      console.error('Upload failed:', error);
      alert('Upload failed. Please try again.'); // Simple error handling
    } finally {
      setIsUploading(false);
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const renderStepContent = () => {
    switch (step) {
      case 1: // Upload Video
        return (
            <div className="flex flex-col items-center justify-center h-full border-2 border-dashed rounded-xl p-10 mt-4 bg-muted/20 hover:bg-muted/40 transition-colors">
                <input 
                    type="file" 
                    id="video-upload" 
                    className="hidden" 
                    accept="video/mp4,video/quicktime,video/webm"
                    onChange={handleFileChange}
                />
                <Label htmlFor="video-upload" className="cursor-pointer flex flex-col items-center gap-4">
                    <div className="p-4 bg-background rounded-full shadow-sm">
                        <Upload className="w-8 h-8 text-primary" />
                    </div>
                    <div className="text-center">
                        <h3 className="text-lg font-semibold">
                            {file ? file.name : 'Select Video File'}
                        </h3>
                        <p className="text-sm text-muted-foreground mt-1">
                            {file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` : 'MP4, MOV or WebM'}
                        </p>
                    </div>
                    {!file && <Button variant="secondary" className="mt-2">Choose File</Button>}
                </Label>
            </div>
        );
      case 2: // Asset Type
        return (
          <div className="grid grid-cols-3 gap-4 mt-4">
             <SelectionCard 
                icon={Tv} 
                label="TV" 
                selected={selections.type === 'tv'} 
                onClick={() => setSelections({...selections, type: 'tv'})} 
             />
             <SelectionCard 
                icon={Film} 
                label="Movie" 
                selected={selections.type === 'movie'} 
                onClick={() => setSelections({...selections, type: 'movie'})} 
             />
             <SelectionCard 
                icon={Sparkles} 
                label="UGC" 
                selected={selections.type === 'ugc'} 
                onClick={() => setSelections({...selections, type: 'ugc'})} 
             />
          </div>
        );
      case 3: // Platform
        return (
          <div className="grid grid-cols-3 gap-4 mt-4">
             <SelectionCard 
                icon={FaTiktok} 
                label="TikTok" 
                selected={selections.platform === 'tiktok'} 
                onClick={() => setSelections({...selections, platform: 'tiktok'})} 
             />
             <SelectionCard 
                icon={FaInstagram} 
                label="IG Reels" 
                selected={selections.platform === 'ig'} 
                onClick={() => setSelections({...selections, platform: 'ig'})} 
             />
             <SelectionCard 
                icon={SiYoutubeshorts} 
                label="Shorts" 
                selected={selections.platform === 'shorts'} 
                onClick={() => setSelections({...selections, platform: 'shorts'})} 
             />
             <SelectionCard 
                icon={FaYoutube} 
                label="YouTube" 
                selected={selections.platform === 'youtube'} 
                onClick={() => setSelections({...selections, platform: 'youtube'})} 
             />
             <SelectionCard 
                icon={Tv} 
                label="SmartTV" 
                selected={selections.platform === 'tv'} 
                onClick={() => setSelections({...selections, platform: 'tv'})} 
             />
             <SelectionCard 
                icon={Car} 
                label="Automotive" 
                selected={selections.platform === 'auto'} 
                onClick={() => setSelections({...selections, platform: 'auto'})} 
             />
          </div>
        );
      case 4: // Format
        return (
           <div className="grid grid-cols-3 gap-4 mt-4">
             <SelectionCard 
                icon={Scissors} 
                label="Short Single" 
                selected={selections.format === 'short'} 
                onClick={() => setSelections({...selections, format: 'short'})} 
             />
             <SelectionCard 
                icon={BookOpen} 
                label="Full Story" 
                selected={selections.format === 'full'} 
                onClick={() => setSelections({...selections, format: 'full'})} 
             />
             <SelectionCard 
                icon={Flame} 
                label="Highlight" 
                selected={selections.format === 'highlight'} 
                onClick={() => setSelections({...selections, format: 'highlight'})} 
             />
          </div>
        );
      case 5: // Audience
        return (
            <div className="space-y-6 mt-4">
                <div className="space-y-3">
                    <Label>Gender</Label>
                    <div className="flex gap-4">
                        {['Male', 'Female', 'All'].map(g => (
                            <Button 
                                key={g}
                                variant={selections.audience.gender === g.toLowerCase() ? 'default' : 'outline'}
                                onClick={() => setSelections({
                                    ...selections, 
                                    audience: {...selections.audience, gender: g.toLowerCase()}
                                })}
                                className="flex-1"
                            >
                                {g}
                            </Button>
                        ))}
                    </div>
                </div>
                <div className="space-y-3">
                    <Label>Age Range</Label>
                    <div className="grid grid-cols-1 gap-2">
                        {['13-17', '18-24', '25-34'].map(range => (
                             <div 
                                key={range} 
                                className={cn(
                                    "flex items-center gap-2 p-3 border rounded-md cursor-pointer transition-colors",
                                    selections.audience.age.includes(range) ? "border-primary bg-primary/10" : "hover:bg-muted"
                                )}
                                onClick={() => {
                                    const current = selections.audience.age;
                                    const newAge = current.includes(range) 
                                        ? current.filter((a: string) => a !== range)
                                        : [...current, range];
                                    setSelections({
                                        ...selections,
                                        audience: {...selections.audience, age: newAge}
                                    });
                                }}
                             >
                                <div className={cn(
                                    "h-4 w-4 rounded border flex items-center justify-center",
                                    selections.audience.age.includes(range) ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground"
                                )}>
                                    {selections.audience.age.includes(range) && <div className="h-2 w-2 bg-current rounded-sm" />}
                                </div>
                                <span className="text-sm">{range}</span>
                             </div>
                        ))}
                    </div>
                </div>
            </div>
        );
      case 6: // Driver
        return (
            <div className="grid grid-cols-3 gap-4 mt-4">
             <SelectionCard 
                icon={Megaphone} 
                label="Marketing" 
                selected={selections.driver === 'marketing'} 
                onClick={() => setSelections({...selections, driver: 'marketing'})} 
             />
             <SelectionCard 
                icon={Clapperboard} 
                label="Teaser" 
                selected={selections.driver === 'teaser'} 
                onClick={() => setSelections({...selections, driver: 'teaser'})} 
             />
             <SelectionCard 
                icon={Eye} 
                label="Viewership" 
                selected={selections.driver === 'viewership'} 
                onClick={() => setSelections({...selections, driver: 'viewership'})} 
             />
          </div>
        );
      case 7: // Language
         return (
            <div className="grid grid-cols-3 gap-4 mt-4">
             <SelectionCard 
                icon={Languages} 
                label="English" 
                selected={selections.language === 'english'} 
                onClick={() => setSelections({...selections, language: 'english'})} 
             />
             <SelectionCard 
                icon={Languages} 
                label="Spanish" 
                selected={selections.language === 'spanish'} 
                onClick={() => setSelections({...selections, language: 'spanish'})} 
             />
             <SelectionCard 
                icon={Languages} 
                label="..." 
                selected={false} 
                onClick={() => {}} 
                className="opacity-50"
             />
          </div>
         );
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => !isUploading && onOpenChange(val)}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
             <span>Upload Video - Step {step} of {STEPS.length}</span>
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1.5">
            {STEPS[step - 1].description}
          </p>
        </DialogHeader>

        <div className="py-4 min-h-[300px]">
            {renderStepContent()}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button variant="ghost" onClick={handleBack} disabled={step === 1 || isUploading}>
             <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          <Button onClick={handleNext} disabled={(step === 1 && !file) || isUploading}>
             {isUploading ? (
               <>Uploading <Loader2 className="w-4 h-4 ml-2 animate-spin" /></>
             ) : (
               step === STEPS.length ? <>Finish <ArrowRight className="w-4 h-4 ml-2" /></> : <>Next <ArrowRight className="w-4 h-4 ml-2" /></>
             )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SelectionCardProps {
    icon: any;
    label: string;
    selected: boolean;
    onClick: () => void;
    className?: string;
}

function SelectionCard({ icon: Icon, label, selected, onClick, className }: SelectionCardProps) {
    return (
        <div 
            onClick={onClick}
            className={cn(
                "flex flex-col items-center justify-center gap-3 p-6 rounded-xl border-2 cursor-pointer transition-all hover:bg-accent/50",
                selected ? "border-blue-500 bg-blue-500/10" : "border-muted",
                className
            )}
        >
            <div className={cn(
                "p-3 rounded-lg",
                selected ? "bg-blue-500 text-white" : "bg-muted text-foreground"
            )}>
                <Icon className="h-8 w-8" />
            </div>
            <span className="font-medium text-center">{label}</span>
        </div>
    )
}
