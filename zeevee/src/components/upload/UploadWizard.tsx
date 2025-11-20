import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useDispatch } from 'react-redux';
import { addAsset } from '@/store/assetsSlice';
import { Tv, Film, Sparkles, Car, Scissors, BookOpen, Flame, Megaphone, Clapperboard, Eye, Languages, ArrowRight, ArrowLeft } from 'lucide-react';
import { FaTiktok, FaInstagram, FaYoutube } from "react-icons/fa";
import { SiYoutubeshorts } from "react-icons/si";
import { cn } from '@/lib/utils';

// Mock installation of checkbox and radio-group if I forgot them
// But I will use standard buttons as selection cards for better UI as per design

interface UploadWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STEPS = [
  { id: 1, title: 'Asset Type', description: 'What kind of content do you want to edit?' },
  { id: 2, title: 'Target Platform', description: 'Select your target platform' },
  { id: 3, title: 'Output Format', description: 'Choose content format' },
  { id: 4, title: 'Target Audience', description: 'Define your intended audience' },
  { id: 5, title: 'Business Driver', description: "What's the purpose of this content?" },
  { id: 6, title: 'Output Language', description: "What's the purpose of this content?" },
];

export function UploadWizard({ open, onOpenChange }: UploadWizardProps) {
  const [step, setStep] = useState(1);
  const dispatch = useDispatch();
  const [selections, setSelections] = useState<Record<string, any>>({
      type: '',
      platform: '',
      format: '',
      audience: { gender: 'all', age: ['18-24'] },
      driver: '',
      language: 'english'
  });

  const handleNext = () => {
    if (step < STEPS.length) {
      setStep(step + 1);
    } else {
      // Finish
      const newAsset = {
        id: Math.random().toString(36).substring(7),
        title: `New Upload - ${selections.type}`,
        thumbnail: 'https://images.unsplash.com/photo-1626814026160-2237a95fc5a0?w=800&auto=format&fit=crop&q=60',
        status: 'processing' as const,
        format: '1080p',
        size: '0 MB',
        segmentCount: 0,
        views: 0,
        createdAt: new Date().toISOString()
      };
      dispatch(addAsset(newAsset));
      onOpenChange(false);
      setStep(1);
      setSelections({
          type: '',
          platform: '',
          format: '',
          audience: { gender: 'all', age: ['18-24'] },
          driver: '',
          language: 'english'
      });
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const renderStepContent = () => {
    switch (step) {
      case 1: // Asset Type
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
      case 2: // Platform
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
      case 3: // Format
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
      case 4: // Audience
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
      case 5: // Driver
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
      case 6: // Language
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          <Button variant="ghost" onClick={handleBack} disabled={step === 1}>
             <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          <Button onClick={handleNext}>
             {step === STEPS.length ? 'Finish' : 'Next'} <ArrowRight className="w-4 h-4 ml-2" />
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

